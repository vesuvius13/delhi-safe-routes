/* "Safe places near me" and "Share my location". Works from the planner and during
 * navigation. Uses globals from app.js (map, state, setPoint, distancesOnce, km, mins,
 * escapeHtml, startAfterRoute) and nav.js (Nav).
 */
'use strict';

const Safety = (() => {
  const SEARCH_RADIUS_M = 5000;
  const METRO_OPEN = [5 * 60 + 30, 23 * 60 + 30]; // Delhi Metro runs roughly 5:30am to 11:30pm
  const KIND = {
    police: { label: 'Police', icon: '<i class="key-police"></i>' },
    hospital: { label: 'Hospital', icon: '<i class="key-hospital"></i>' },
    metro: { label: 'Metro station', icon: '<i class="key-other">M</i>' },
    rail: { label: 'Railway station', icon: '<i class="key-other">R</i>' },
    fuel: { label: 'Fuel station', icon: '<i class="key-other">F</i>' },
    pharmacy: { label: 'Pharmacy', icon: '<i class="key-other">+</i>' },
  };

  const el = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ sheet

  function openSheet(title, html) {
    el('sheet-title').textContent = title;
    el('sheet-body').innerHTML = html;
    el('sheet').hidden = false;
    el('sheet-close').focus();
  }
  function closeSheet() { el('sheet').hidden = true; }
  el('sheet-close').onclick = closeSheet;
  el('sheet').addEventListener('click', (e) => { if (e.target === el('sheet')) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('sheet').hidden) closeSheet(); });

  // ------------------------------------------------------------------ location

  /** Current position as {ll, acc}; uses the navigation fix when navigating. */
  function currentPosition() {
    if (typeof Nav !== 'undefined' && Nav.active && Nav.position) return Promise.resolve({ ll: Nav.position, acc: null });
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Location is not available in this browser.'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ ll: [+p.coords.longitude.toFixed(6), +p.coords.latitude.toFixed(6)], acc: Math.round(p.coords.accuracy) }),
        (err) => reject(new Error(err.code === 1 ? 'Location permission is off. Allow location for this site and try again.' : 'Could not get your location. Try again, ideally outdoors.')),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
      );
    });
  }

  // ------------------------------------------------------------------ opening hours

  const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  /** Rough OSM opening_hours check for now: true, false, or null if we can't tell. */
  function hoursOpen(spec, now = new Date()) {
    if (!spec) return null;
    if (/24\s*\/\s*7/.test(spec)) return true;
    const today = now.getDay(), minute = now.getHours() * 60 + now.getMinutes();
    let matched = false;
    for (const rule of spec.split(';').map((r) => r.trim()).filter(Boolean)) {
      const dayPart = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)\s*/);
      if (dayPart) {
        const covers = dayPart[1].split(',').filter(Boolean).some((d) => {
          const [a, b = a] = d.split('-').map((x) => DAYS.indexOf(x));
          return a <= b ? today >= a && today <= b : today >= a || today <= b;
        });
        if (!covers) continue;
      }
      const rest = dayPart ? rule.slice(dayPart[0].length) : rule;
      if (/\b(off|closed)\b/i.test(rest)) return false;
      const ranges = [...rest.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
      if (!ranges.length) continue;
      matched = true;
      for (const [, h1, m1, h2, m2] of ranges) {
        const a = +h1 * 60 + +m1, b = +h2 * 60 + +m2;
        if (b > a ? minute >= a && minute < b : minute >= a || minute < b) return true;
      }
    }
    return matched ? false : null;
  }

  /** {open: true|false|null, label} for a safe place right now. */
  function openStatus(p, now = new Date()) {
    if (p.k === 'police' || p.k === 'hospital') return { open: true, label: 'Open 24 hours' };
    if (p.k === 'rail') return { open: true, label: 'Usually open 24 hours' };
    if (p.k === 'metro') {
      const m = now.getHours() * 60 + now.getMinutes();
      return m >= METRO_OPEN[0] && m < METRO_OPEN[1]
        ? { open: true, label: 'Metro running (till about 11:30 pm)' }
        : { open: false, label: 'Metro closed now' };
    }
    const o = hoursOpen(p.h, now);
    if (o === true) return { open: true, label: /24\s*\/\s*7/.test(p.h) ? 'Open 24 hours' : 'Open now' };
    if (o === false) return { open: false, label: 'Closed now' };
    return { open: null, label: 'Hours not listed' };
  }

  // ------------------------------------------------------------------ safe places

  const PER_GROUP = { police: 2, hospital: 2, other: 3 };

  async function showSafePlaces() {
    openSheet('Safe places near you', '<p class="sheet-note">Finding your location…</p>');
    let pos, note = '';
    try {
      pos = await currentPosition();
    } catch (err) {
      const c = map.getCenter();
      pos = { ll: [c.lng, c.lat], acc: null };
      note = `${escapeHtml(err.message)} Showing places near the centre of the map instead.`;
    }
    el('sheet-body').innerHTML = '<p class="sheet-note">Checking walking distances…</p>';

    // Straight-line shortlist per group, then rank by actual walking distance.
    const kx = 111320 * Math.cos((28.61 * Math.PI) / 180), ky = 110540;
    const [qx, qy] = [pos.ll[0] * kx, pos.ll[1] * ky];
    const now = new Date();
    const seenNames = new Set();
    const pool = state.places
      .map((p) => ({ p, d: Math.hypot(p.lon * kx - qx, p.lat * ky - qy), st: openStatus(p, now) }))
      .filter((c) => c.d <= SEARCH_RADIUS_M && c.st.open !== false)
      .sort((a, b) => a.d - b.d)
      .filter((c) => { // one entry per metro station, not one per gate
        if (c.p.k !== 'metro' || !c.p.n) return true;
        const key = c.p.n.toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(gate|exit|entry|metro|station)\b.*$/, '').trim();
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });
    const group = (c) => (c.p.k === 'police' || c.p.k === 'hospital' ? c.p.k : 'other');
    const shortlist = [];
    for (const g of Object.keys(PER_GROUP)) shortlist.push(...pool.filter((c) => group(c) === g).slice(0, PER_GROUP[g] + 2));
    if (!shortlist.length) {
      el('sheet-body').innerHTML = `${note ? `<p class="sheet-note">${note}</p>` : ''}<p class="sheet-note">No safe places found within ${km(SEARCH_RADIUS_M)}. If you are in danger, call 112.</p>${sosRow()}`;
      return;
    }

    const res = await distancesOnce(pos.ll, shortlist.map((c) => [c.p.lon, c.p.lat]));
    if (res.error) {
      el('sheet-body').innerHTML = `<p class="sheet-note">${escapeHtml(res.error)}</p>${sosRow()}`;
      return;
    }
    shortlist.forEach((c, i) => { c.walk = res.distances[i]; });
    const picked = [];
    for (const g of Object.keys(PER_GROUP)) {
      picked.push(...shortlist.filter((c) => group(c) === g && c.walk != null).sort((a, b) => a.walk - b.walk).slice(0, PER_GROUP[g]));
    }
    picked.sort((a, b) => a.walk - b.walk);

    el('sheet-body').innerHTML = `
      ${note ? `<p class="sheet-note">${note}</p>` : '<p class="sheet-note">Ranked by walking distance from where you are.</p>'}
      <ul class="safe-list">${picked.map((c, i) => placeRow(c, i)).join('')}</ul>
      ${sosRow()}`;
    el('sheet-body').querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = () => goTo(picked[+b.dataset.go].p, pos.ll);
    });
  }

  function placeRow(c, i) {
    const k = KIND[c.p.k];
    const name = c.p.n || k.label;
    const phone = c.p.p || (c.p.k === 'police' ? '112' : '');
    return `<li>
      <span class="safe-icon">${k.icon}</span>
      <span class="safe-text"><b>${escapeHtml(name)}</b>
        <small>${escapeHtml(k.label)} · ${km(c.walk)} · ${mins(c.walk)} walk</small>
        <small class="${c.st.open ? 'ok' : ''}">${escapeHtml(c.st.label)}</small></span>
      <span class="safe-actions">
        <button class="go-btn" type="button" data-go="${i}">Go</button>
        ${phone ? `<a class="call-btn" href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}">Call${c.p.p ? '' : ' 112'}</a>` : ''}
      </span>
    </li>`;
  }

  const sosRow = () => '<div class="sheet-sos"><a href="tel:112" class="pill danger">Call 112</a><a href="tel:1091" class="pill">1091 Women helpline</a></div>';

  /** Walk to a safe place: reroute the current navigation, or plan and start a new one. */
  function goTo(p, fromLL) {
    closeSheet();
    const label = p.n || KIND[p.k].label;
    if (typeof Nav !== 'undefined' && Nav.active) {
      Nav.retarget([p.lon, p.lat], label);
      return;
    }
    startAfterRoute = true;
    setPoint('from', fromLL, 'My location', false);
    setPoint('to', [p.lon, p.lat], label);
  }

  // ------------------------------------------------------------------ share location

  async function shareLocation() {
    openSheet('Share my location', '<p class="sheet-note">Finding your location…</p>');
    let pos;
    try {
      pos = await currentPosition();
    } catch (err) {
      el('sheet-body').innerHTML = `<p class="sheet-note">${escapeHtml(err.message)}</p>`;
      return;
    }
    const [lon, lat] = pos.ll;
    const link = `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
    const time = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    let text = `This is my location at ${time}${pos.acc ? ` (accurate to about ${pos.acc} m)` : ''}: ${link}`;
    const dest = document.getElementById('to').value;
    if (typeof Nav !== 'undefined' && Nav.active && Nav.eta) {
      text += `\nI'm walking${dest && dest !== 'Dropped pin' ? ` to ${dest}` : ''} and expect to arrive around ${Nav.eta}.`;
    }
    const enc = encodeURIComponent(text);
    el('sheet-body').innerHTML = `
      <p class="share-preview">${escapeHtml(text).replace(/\n/g, '<br>')}</p>
      <div class="share-actions">
        <a class="share-btn wa" href="https://wa.me/?text=${enc}" target="_blank" rel="noopener">WhatsApp</a>
        <a class="share-btn" href="sms:?&body=${enc}">SMS</a>
        ${navigator.share ? '<button class="share-btn" type="button" id="share-more">More…</button>' : ''}
        <button class="share-btn" type="button" id="share-copy">Copy</button>
      </div>
      <p class="sheet-note">Only the person you send it to gets your location. It's a one-time snapshot: share again to update it.</p>`;
    el('share-more')?.addEventListener('click', () => navigator.share({ title: 'My location', text }).catch(() => {}));
    el('share-copy').onclick = async (e) => {
      try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Copy failed'; }
    };
  }

  // ------------------------------------------------------------------ buttons

  for (const id of ['safe-btn', 'nav-safe']) el(id).onclick = showSafePlaces;
  for (const id of ['share-btn', 'nav-share']) el(id).onclick = shareLocation;

  return { showSafePlaces, shareLocation, openStatus, hoursOpen };
})();
