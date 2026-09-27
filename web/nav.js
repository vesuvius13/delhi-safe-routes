/* Turn-by-turn navigation: follows GPS along the planned route, announces turns,
 * and reroutes from where you are if you leave the route. Uses globals from app.js
 * (map, state, routeOnce, segmentsFC, emptyFC, maneuverIcon, escapeHtml, km, plannerPadding).
 * Location is only used on this device.
 */
'use strict';

const Nav = (() => {
  const OFF_ROUTE_M = 40;      // this far from the route (twice in a row) triggers a reroute
  const START_NEAR_M = 150;    // farther than this from the route start: route from where you are
  const ARRIVE_M = 20;
  const WEAK_GPS_M = 80;       // fixes less accurate than this don't count towards rerouting
  const ANNOUNCE_EARLY_M = 120;
  const ANNOUNCE_NOW_M = 25;
  const LOOK_AHEAD_M = 25;     // camera faces the route this far ahead
  const P = { kx: 111320 * Math.cos((28.6139 * Math.PI) / 180), ky: 110540 };

  let active = false, route = null, xy = [], cum = [], watchId = null, wakeLock = null;
  let following = true, offCount = 0, rerouting = false, lastLL = null, spoken = new Set();
  let muted = false;
  try { muted = localStorage.getItem('nav-muted') === '1'; } catch { /* storage unavailable */ }

  const el = (id) => document.getElementById(id);
  const toXY = ([lon, lat]) => [lon * P.kx, lat * P.ky];

  function useRoute(r) {
    route = r;
    xy = r.coords.map(toXY);
    cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    spoken = new Set();
    offCount = 0;
    map.getSource('safest')?.setData(segmentsFC(r));
    map.getSource('shortest')?.setData(emptyFC());
  }

  /** Nearest point on the route: {along (m from start), dist (m off route), i (segment index)}. */
  function project(ll) {
    const [px, py] = toXY(ll);
    let best = { along: 0, dist: Infinity, i: 0 };
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1], [bx, by] = xy[i];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best.dist) best = { along: cum[i - 1] + t * (cum[i] - cum[i - 1]), dist: d, i };
    }
    return best;
  }

  /** [lon, lat] at a distance along the route. */
  function pointAt(along) {
    const total = cum[cum.length - 1];
    along = Math.max(0, Math.min(total, along));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < along) i++;
    const seg = cum[i] - cum[i - 1], t = seg ? (along - cum[i - 1]) / seg : 0;
    const a = route.coords[i - 1], b = route.coords[i];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }

  const bearing = (a, b) => {
    const [ax, ay] = toXY(a), [bx, by] = toXY(b);
    return (Math.atan2(bx - ax, by - ay) * 180) / Math.PI;
  };

  // ------------------------------------------------------------------ voice & screen

  function speak(text) {
    if (muted || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    speechSynthesis.speak(u);
  }

  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported or denied */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (active && document.visibilityState === 'visible') keepAwake();
  });

  // ------------------------------------------------------------------ UI

  function banner(icon, dist, text) {
    el('nav-icon').innerHTML = icon;
    el('nav-dist').textContent = dist;
    el('nav-instr').textContent = text;
  }

  const navDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : m >= 100 ? `${Math.round(m / 10) * 10} m` : `${Math.max(5, Math.round(m / 5) * 5)} m`);
  const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);

  function updateBottom(remaining, weak) {
    const secs = remaining / (WALK_KMH / 3.6);
    const eta = new Date(Date.now() + secs * 1000).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    el('nav-time').textContent = `${Math.max(1, Math.round(secs / 60))} min`;
    el('nav-meta').textContent = `${km(remaining)} · arrive ${eta}${weak ? ' · weak GPS' : ''}`;
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('nav-muted', m ? '1' : '0'); } catch { /* storage unavailable */ }
    el('nav-mute').setAttribute('aria-pressed', String(m));
    el('nav-mute').title = m ? 'Turn voice on' : 'Mute voice';
    if (m && 'speechSynthesis' in window) speechSynthesis.cancel();
  }

  // ------------------------------------------------------------------ tracking

  function onFix(pos) {
    if (!active) return;
    const ll = [pos.coords.longitude, pos.coords.latitude];
    const acc = pos.coords.accuracy || 0;
    lastLL = ll;
    map.getSource('me')?.setData({ type: 'Point', coordinates: ll });
    if (rerouting) return;

    const p = project(ll);
    const weak = acc > WEAK_GPS_M;
    if (!weak && p.dist > Math.max(OFF_ROUTE_M, acc)) {
      if (++offCount >= 2) return reroute(ll);
    } else {
      offCount = 0;
    }

    const total = cum[cum.length - 1];
    const remaining = Math.max(0, total - p.along);
    if (remaining < ARRIVE_M && p.dist < OFF_ROUTE_M) return arrive();

    const k = route.steps.findIndex((s) => s.along > p.along + 3);
    const next = route.steps[k] || route.steps[route.steps.length - 1];
    const toNext = Math.max(0, next.along - p.along);
    banner(maneuverIcon(next, 44), navDist(toNext), next.text);
    const after = route.steps[k + 1];
    const showThen = after && after.along - next.along < 150;
    el('nav-then').hidden = !showThen;
    if (showThen) el('nav-then').innerHTML = `Then ${maneuverIcon(after, 18)} ${escapeHtml(after.text)}`;
    updateBottom(remaining, weak);

    if (toNext <= ANNOUNCE_NOW_M && !spoken.has(`${k}:now`)) {
      spoken.add(`${k}:now`).add(`${k}:early`);
      if (next.type !== 'arrive') speak(next.text); // arrive() has its own announcement
    } else if (toNext <= ANNOUNCE_EARLY_M && toNext > ANNOUNCE_NOW_M * 2 && !spoken.has(`${k}:early`)) {
      spoken.add(`${k}:early`);
      speak(`In ${Math.round(toNext / 10) * 10} metres, ${lower(next.text)}`);
    }

    // Walked part in grey
    const walked = route.coords.slice(0, p.i).concat([pointAt(p.along)]);
    map.getSource('traveled')?.setData(walked.length > 1 ? { type: 'LineString', coordinates: walked } : emptyFC());

    if (following) {
      map.easeTo({ center: ll, bearing: bearing(pointAt(p.along), pointAt(p.along + LOOK_AHEAD_M)), zoom: 17.5, pitch: 0, duration: 800 });
    }
  }

  function onGpsError(err) {
    if (!active) return;
    const msg = err.code === 1 ? 'Location permission is off. Allow location to navigate.' : 'Waiting for GPS signal…';
    el('nav-meta').textContent = msg;
  }

  async function reroute(ll) {
    rerouting = true;
    banner(maneuverIcon({ type: 'depart', turn: 0 }, 44), '', 'Finding a new route…');
    speak('Rerouting');
    const res = await routeOnce([+ll[0].toFixed(6), +ll[1].toFixed(6)]);
    rerouting = false;
    if (!active) return;
    if (res.error) {
      banner(maneuverIcon({ type: 'depart', turn: 0 }, 44), '', res.error);
      return false;
    }
    useRoute(res.safest);
    map.getSource('traveled')?.setData(emptyFC());
    if (lastLL) onFix({ coords: { longitude: lastLL[0], latitude: lastLL[1], accuracy: 10 } });
    return true;
  }

  function arrive() {
    stopTracking();
    banner(maneuverIcon({ type: 'arrive' }, 44), '', 'You have arrived');
    el('nav-then').hidden = true;
    el('nav-meta').textContent = 'Stay safe.';
    el('nav-time').textContent = 'Arrived';
    el('nav-end').textContent = 'Done';
    speak('You have arrived');
  }

  function stopTracking() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  // ------------------------------------------------------------------ start / end

  async function start(r) {
    if (!navigator.geolocation) {
      showStatus('Navigation needs location, which this browser does not provide.', true);
      return;
    }
    active = true;
    following = true;
    document.body.classList.add('navigating');
    el('nav').hidden = false;
    el('nav-recenter').hidden = true;
    el('nav-then').hidden = true;
    el('nav-end').textContent = 'End';
    el('nav-time').textContent = '';
    el('nav-meta').textContent = '';
    map.setPadding({ top: innerHeight * 0.4, bottom: 110, left: 20, right: 20 });
    banner(maneuverIcon({ type: 'depart', turn: 0 }, 44), '', 'Finding your location…');
    keepAwake();

    useRoute(r);
    let first;
    try {
      first = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 }));
    } catch (err) {
      banner(maneuverIcon({ type: 'depart', turn: 0 }, 44), '', err.code === 1
        ? 'Location permission is off. Allow location to start navigation.'
        : 'Could not get your location. Try again outdoors.');
      return;
    }
    if (!active) return;
    const ll = [first.coords.longitude, first.coords.latitude];
    // Not at the planned start: route from where you are
    if (project(ll).dist > START_NEAR_M && !(await reroute(ll))) return;
    if (!active) return;
    speak(route.steps[0].text);
    onFix(first);
    watchId = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }

  function end() {
    active = false;
    stopTracking();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    document.body.classList.remove('navigating');
    el('nav').hidden = true;
    map.getSource('traveled')?.setData(emptyFC());
    map.getSource('me')?.setData(emptyFC());
    map.setPadding(plannerPadding());
    map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
    if (state.last) { fitNext = true; renderRoute(state.last); }
  }

  // ------------------------------------------------------------------ controls

  el('nav-end').onclick = end;
  el('nav-mute').onclick = () => setMuted(!muted);
  el('nav-recenter').onclick = () => {
    following = true;
    el('nav-recenter').hidden = true;
    if (lastLL) onFix({ coords: { longitude: lastLL[0], latitude: lastLL[1], accuracy: 10 } });
  };
  // Panning the map yourself pauses follow mode until you tap Re-centre
  map.on('movestart', (e) => {
    if (!active || !e.originalEvent) return;
    following = false;
    el('nav-recenter').hidden = false;
  });
  setMuted(muted);

  return { start, end, get active() { return active; } };
})();
