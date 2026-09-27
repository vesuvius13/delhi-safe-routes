/* Demo mode, for recording videos away from Delhi. Only active with ?demo in the URL
 * (?demo=10 sets the walking speed multiplier; default 5x).
 *
 * Replaces the browser's GPS with a simulated position: you "are" at the start of the
 * route you plan, and after tapping Start you walk along it. A visible badge says the
 * location is simulated, and shared messages are marked as a demo.
 * Uses globals from app.js / nav.js at call time (state, Nav).
 */
'use strict';

const DEMO = (() => {
  const param = new URLSearchParams(location.search).get('demo');
  if (param === null) return null;

  const SPEED = 1.25 * (Number(param) > 0 ? Math.min(Number(param), 30) : 5); // metres per second
  const TICK_MS = 700;
  const DEFAULT_POS = [77.2195, 28.6328]; // Rajiv Chowk
  const P = { kx: 111320 * Math.cos((28.6139 * Math.PI) / 180), ky: 110540 };

  let pos = null;
  const here = () => pos || (typeof state !== 'undefined' && state.from) || DEFAULT_POS;
  const fix = (ll) => ({ coords: { longitude: ll[0], latitude: ll[1], accuracy: 5, heading: null, speed: null }, timestamp: Date.now() });

  /** Distance along a polyline to the point nearest ll. */
  function projectAlong(ll, coords) {
    const px = ll[0] * P.kx, py = ll[1] * P.ky;
    let best = Infinity, along = 0, acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const ax = coords[i - 1][0] * P.kx, ay = coords[i - 1][1] * P.ky;
      const bx = coords[i][0] * P.kx, by = coords[i][1] * P.ky;
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
      const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (L * L))) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best) { best = d; along = acc + t * L; }
      acc += L;
    }
    return along;
  }

  function pointAlong(coords, along) {
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      const L = Math.hypot((b[0] - a[0]) * P.kx, (b[1] - a[1]) * P.ky);
      if (acc + L >= along) {
        const t = L ? (along - acc) / L : 0;
        return { ll: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], done: false };
      }
      acc += L;
    }
    return { ll: coords[coords.length - 1], done: true };
  }

  const watchers = new Map();
  let nextId = 1;

  const geolocation = {
    getCurrentPosition(ok) {
      pos = here();
      setTimeout(() => ok(fix(pos)), 300);
    },
    watchPosition(ok) {
      const id = nextId++;
      let coords = null, along = 0, started = Date.now();
      const timer = setInterval(() => {
        const route = typeof Nav !== 'undefined' ? Nav.coords : null;
        if (!route) return ok(fix(here()));
        if (route !== coords) { coords = route; along = projectAlong(here(), coords); } // new or rerouted route
        if (Date.now() - started > 1500) along += SPEED * (TICK_MS / 1000); // a short pause to read the first instruction
        const p = pointAlong(coords, along);
        pos = p.ll;
        ok(fix(pos));
      }, TICK_MS);
      watchers.set(id, timer);
      return id;
    },
    clearWatch(id) {
      clearInterval(watchers.get(id));
      watchers.delete(id);
    },
  };

  try {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => geolocation });
  } catch { /* fall through */ }
  if (navigator.geolocation !== geolocation) {
    Object.defineProperty(Navigator.prototype, 'geolocation', { configurable: true, get: () => geolocation });
  }

  document.documentElement.classList.add('demo');
  document.addEventListener('DOMContentLoaded', () => {
    const badge = document.createElement('div');
    badge.className = 'demo-badge';
    badge.textContent = 'DEMO · simulated location';
    badge.title = 'Demo mode: your location is simulated. Remove ?demo from the address to use real GPS.';
    document.body.appendChild(badge);
  });

  return { speed: SPEED };
})();
