/* Routing worker: loads the Delhi walking graph once, then answers route
 * queries with A*. Runs entirely in the browser; locations never leave the device.
 *
 * Edge cost = length * (1 + alpha * riskMultiplier * risk[band]); alpha = 0 is
 * the shortest path. The heuristic is straight-line distance, which stays
 * admissible because cost >= length >= straight-line distance.
 */
'use strict';

let G = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data.base);
    else if (data.type === 'route') self.postMessage({ type: 'route', id: data.id, ...route(data) });
    else if (data.type === 'distances') self.postMessage({ type: 'distances', id: data.id, ...distances(data) });
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String((err && err.message) || err) });
  }
};

// ------------------------------------------------------------------ loading

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function gunzip(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer; // server already decoded it
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

const CELL = 150; // metres, snapping grid

async function load(base) {
  const [meta, names] = await Promise.all([
    fetch(base + 'meta.json').then((r) => r.json()),
    fetch(base + 'names.json').then((r) => r.json()),
  ]);
  const raw = await fetchBytes(base + 'graph.bin.gz', (got, total) =>
    self.postMessage({ type: 'progress', got, total }));
  const buf = await gunzip(raw);
  const T = { int32: Int32Array, uint32: Uint32Array, float32: Float32Array, uint16: Uint16Array, uint8: Uint8Array };
  const S = {};
  for (const [k, s] of Object.entries(meta.sections)) S[k] = new T[s.dtype](buf, s.offset, s.length);

  const N = meta.nodes, E = meta.edges, P = meta.projection;
  const x = new Float64Array(N), y = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = (S.nodes[2 * i] / 1e6 - P.lon0) * P.kx;
    y[i] = (S.nodes[2 * i + 1] / 1e6 - P.lat0) * P.ky;
  }
  const GN = S.geom.length / 2;
  const gx = new Float64Array(GN), gy = new Float64Array(GN);
  for (let i = 0; i < GN; i++) {
    gx[i] = (S.geom[2 * i] / 1e6 - P.lon0) * P.kx;
    gy[i] = (S.geom[2 * i + 1] / 1e6 - P.lat0) * P.ky;
  }

  // CSR adjacency (undirected: every edge is walkable both ways)
  const off = new Uint32Array(N + 1);
  for (let e = 0; e < E; e++) { off[S.edge_u[e] + 1]++; off[S.edge_v[e] + 1]++; }
  for (let i = 0; i < N; i++) off[i + 1] += off[i];
  const fill = off.slice(0, N);
  const adj = new Uint32Array(2 * E);
  for (let e = 0; e < E; e++) { adj[fill[S.edge_u[e]]++] = e; adj[fill[S.edge_v[e]]++] = e; }

  // Uniform grid over edge bounding boxes, for snapping clicks to the nearest street
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
  }
  const W = Math.ceil((maxX - minX) / CELL) + 1, H = Math.ceil((maxY - minY) / CELL) + 1;
  const bbox = new Float64Array(4 * E);
  for (let e = 0; e < E; e++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const visit = (px, py) => { if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; };
    visit(x[S.edge_u[e]], y[S.edge_u[e]]); visit(x[S.edge_v[e]], y[S.edge_v[e]]);
    for (let k = S.geom_off[e]; k < S.geom_off[e + 1]; k++) visit(gx[k], gy[k]);
    bbox.set([x0, y0, x1, y1], 4 * e);
  }
  const cellCount = new Uint32Array(W * H + 1);
  const forCells = (e, fn) => {
    const cx0 = Math.floor((bbox[4 * e] - minX) / CELL), cy0 = Math.floor((bbox[4 * e + 1] - minY) / CELL);
    const cx1 = Math.floor((bbox[4 * e + 2] - minX) / CELL), cy1 = Math.floor((bbox[4 * e + 3] - minY) / CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * W + cx);
  };
  for (let e = 0; e < E; e++) forCells(e, (c) => cellCount[c + 1]++);
  for (let c = 0; c < W * H; c++) cellCount[c + 1] += cellCount[c];
  const cellFill = cellCount.slice(0, W * H);
  const cellEdges = new Uint32Array(cellCount[W * H]);
  for (let e = 0; e < E; e++) forCells(e, (c) => { cellEdges[cellFill[c]++] = e; });

  G = { meta, names, S, N, E, x, y, gx, gy, off, adj, grid: { minX, minY, W, H, cellCount, cellEdges },
        B: meta.bands.length, K: meta.risk_multiplier, flags: meta.flags };
  self.postMessage({ type: 'ready', nodes: N, edges: E, built: meta.built, osm: meta.osm_timestamp, mapillary: !!meta.mapillary });
}

// ------------------------------------------------------------------ geometry helpers

function toXY(lon, lat) {
  const P = G.meta.projection;
  return [(lon - P.lon0) * P.kx, (lat - P.lat0) * P.ky];
}
function toLonLat(px, py) {
  const P = G.meta.projection;
  return [+(px / P.kx + P.lon0).toFixed(6), +(py / P.ky + P.lat0).toFixed(6)];
}

/** Edge polyline from u to v, in metres, with cumulative distance. */
function edgePolyline(e) {
  const { S, x, y, gx, gy } = G;
  const u = S.edge_u[e], v = S.edge_v[e];
  const px = [x[u]], py = [y[u]];
  for (let k = S.geom_off[e]; k < S.geom_off[e + 1]; k++) { px.push(gx[k]); py.push(gy[k]); }
  px.push(x[v]); py.push(y[v]);
  const cum = [0];
  for (let i = 1; i < px.length; i++) cum.push(cum[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]));
  // Scale to the stored length so partial-edge costs line up with graph costs.
  const scale = cum[cum.length - 1] > 0 ? G.S.edge_len[e] / cum[cum.length - 1] : 1;
  for (let i = 0; i < cum.length; i++) cum[i] *= scale;
  return { px, py, cum };
}

/** Sub-polyline of edge e between along-distances a and b (a > b means walking v -> u). */
function slicePolyline(e, a, b) {
  const { px, py, cum } = edgePolyline(e);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const at = (d) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1];
    const t = seg > 0 ? (d - cum[i - 1]) / seg : 0;
    return [px[i - 1] + t * (px[i] - px[i - 1]), py[i - 1] + t * (py[i] - py[i - 1])];
  };
  const pts = [at(lo)];
  for (let i = 0; i < cum.length; i++) if (cum[i] > lo && cum[i] < hi) pts.push([px[i], py[i]]);
  pts.push(at(hi));
  if (a > b) pts.reverse();
  return pts.map(([qx, qy]) => toLonLat(qx, qy));
}

/** Nearest point on any street to (lon, lat): {e, t (metres from u), d (metres away), lon, lat}. */
function snap(lon, lat, maxDist = 600) {
  const [qx, qy] = toXY(lon, lat);
  const { minX, minY, W, H, cellCount, cellEdges } = G.grid;
  const cx = Math.floor((qx - minX) / CELL), cy = Math.floor((qy - minY) / CELL);
  let best = null;
  const seen = new Set();
  for (let r = 0; r * CELL <= maxDist + CELL; r++) {
    for (let yy = cy - r; yy <= cy + r; yy++) {
      for (let xx = cx - r; xx <= cx + r; xx++) {
        if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== r) continue; // ring only
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const c = yy * W + xx;
        for (let k = cellCount[c]; k < cellCount[c + 1]; k++) {
          const e = cellEdges[k];
          if (seen.has(e)) continue;
          seen.add(e);
          const { px, py, cum } = edgePolyline(e);
          for (let i = 1; i < px.length; i++) {
            const dx = px[i] - px[i - 1], dy = py[i] - py[i - 1];
            const L2 = dx * dx + dy * dy;
            let t = L2 > 0 ? ((qx - px[i - 1]) * dx + (qy - py[i - 1]) * dy) / L2 : 0;
            t = Math.max(0, Math.min(1, t));
            const sx = px[i - 1] + t * dx, sy = py[i - 1] + t * dy;
            const d = Math.hypot(qx - sx, qy - sy);
            if (!best || d < best.d) best = { e, t: cum[i - 1] + t * (cum[i] - cum[i - 1]), d, sx, sy };
          }
        }
      }
    }
    if (best && best.d < r * CELL) break; // nothing in further rings can be closer
  }
  if (!best || best.d > maxDist) return null;
  const [slon, slat] = toLonLat(best.sx, best.sy);
  return { e: best.e, t: best.t, d: best.d, lon: slon, lat: slat, x: best.sx, y: best.sy };
}

// ------------------------------------------------------------------ search

class Heap {
  constructor() { this.f = []; this.n = []; }
  get size() { return this.f.length; }
  push(f, n) {
    const F = this.f, Nn = this.n;
    let i = F.length;
    F.push(f); Nn.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      F[i] = F[p]; Nn[i] = Nn[p]; i = p;
    }
    F[i] = f; Nn[i] = n;
  }
  pop() {
    const F = this.f, Nn = this.n;
    const topF = F[0], topN = Nn[0];
    const lf = F.pop(), ln = Nn.pop();
    if (F.length) {
      let i = 0;
      const L = F.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= L) break;
        if (c + 1 < L && F[c + 1] < F[c]) c++;
        if (F[c] >= lf) break;
        F[i] = F[c]; Nn[i] = Nn[c]; i = c;
      }
      F[i] = lf; Nn[i] = ln;
    }
    return [topF, topN];
  }
}

function search(s, t, alpha, band) {
  const { S, N, x, y, off, adj, B, K } = G;
  const eu = S.edge_u, ev = S.edge_v, len = S.edge_len, risk = S.edge_risk;
  const mult = (e) => 1 + alpha * K * risk[e * B + band] / 255;

  const g = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new Heap();
  const h = (n) => Math.hypot(x[n] - t.x, y[n] - t.y);

  const su = eu[s.e], sv = ev[s.e], tu = eu[t.e], tv = ev[t.e];
  const ms = mult(s.e), mt = mult(t.e);
  const seed = (n, c) => { if (c < g[n]) { g[n] = c; prev[n] = -2; heap.push(c + h(n), n); } };
  seed(su, s.t * ms);
  seed(sv, (len[s.e] - s.t) * ms);
  const exitCost = new Map([[tu, t.t * mt]]);
  exitCost.set(tv, Math.min(exitCost.get(tv) ?? Infinity, (len[t.e] - t.t) * mt));

  let best = Infinity, via = -1;
  if (s.e === t.e) best = Math.abs(s.t - t.t) * ms; // walk straight along the shared street
  let settled = 0;
  while (heap.size) {
    const [f, n] = heap.pop();
    if (f >= best) break;
    if (done[n]) continue;
    done[n] = 1;
    settled++;
    if (exitCost.has(n)) {
      const c = g[n] + exitCost.get(n);
      if (c < best) { best = c; via = n; }
    }
    for (let k = off[n]; k < off[n + 1]; k++) {
      const e = adj[k];
      const m = eu[e] === n ? ev[e] : eu[e];
      if (done[m]) continue;
      const c = g[n] + len[e] * mult(e);
      if (c < g[m]) { g[m] = c; prev[m] = e; heap.push(c + h(m), m); }
    }
  }
  if (best === Infinity) return null;

  // Pieces: [edge, from-along, to-along]
  const pieces = [];
  if (via === -1) {
    pieces.push([s.e, s.t, t.t]);
  } else {
    pieces.push([t.e, via === tu ? 0 : len[t.e], t.t]);
    let n = via;
    while (prev[n] !== -2) {
      const e = prev[n];
      const o = eu[e] === n ? ev[e] : eu[e];
      pieces.push([e, eu[e] === o ? 0 : len[e], eu[e] === n ? 0 : len[e]]);
      n = o;
    }
    pieces.push([s.e, s.t, n === su ? 0 : len[s.e]]);
    pieces.reverse();
  }
  return { pieces, cost: best, settled };
}

// ------------------------------------------------------------------ description

function describe(res, band) {
  const { S, B, flags: F } = G;
  const has = (e, name) => (S.edge_flags[e] >> F[name]) & 1;
  const st = { distance: 0, riskSum: 0, main: 0, lit: 0, litConfirmed: 0, open: 0, nearPolice: 0,
               green: 0, isolatedLand: 0, alongIsolated: 0, pathlike: 0, trunk: 0, alley: 0,
               underpasses: 0, footbridges: 0, darkestStretch: 0, litDetected: 0, surveyed: 0 };
  const coords = [];
  const segments = [];
  const parts = [];
  let dark = 0;
  for (const [e, a, b] of res.pieces) {
    const L = Math.abs(b - a);
    if (L < 0.01) continue;
    const along = st.distance;
    const r = S.edge_risk[e * B + band] / 255;
    const light = S.edge_light[e] / 255;
    st.distance += L;
    st.riskSum += r * L;
    if (has(e, 'main_road')) st.main += L;
    if (light > 0.65) st.lit += L; // main roads, lit=yes tags, mapped lamps; not the residential prior
    if (has(e, 'lit_tag_yes')) st.litConfirmed += L;
    if (F.lit_detected !== undefined && has(e, 'lit_detected')) st.litDetected += L;
    if (F.surveyed !== undefined && has(e, 'surveyed')) st.surveyed += L;
    st.open += (S.edge_open[e * B + band] / G.meta.open_count_scale) * (L / Math.max(S.edge_len[e], 1));
    if (has(e, 'near_police')) st.nearPolice += L;
    if (has(e, 'inside_green')) st.green += L;
    if (has(e, 'inside_isolated_land')) st.isolatedLand += L;
    if (has(e, 'along_isolated')) st.alongIsolated += L;
    if (has(e, 'pathlike')) st.pathlike += L;
    if (has(e, 'trunk')) st.trunk += L;
    if (has(e, 'alley_service')) st.alley += L;
    if (has(e, 'underpass')) st.underpasses++;
    if (has(e, 'footbridge')) st.footbridges++;
    dark = light < 0.4 ? dark + L : 0;
    st.darkestStretch = Math.max(st.darkestStretch, dark);

    const pts = slicePolyline(e, a, b);
    const level = r < 0.25 ? 0 : r < 0.5 ? 1 : 2;
    const last = segments[segments.length - 1];
    if (last && last.level === level) last.coords.push(...pts.slice(1));
    else segments.push({ level, coords: last ? [last.coords[last.coords.length - 1], ...pts.slice(1)] : pts });
    coords.push(...(coords.length ? pts.slice(1) : pts));
    parts.push({ e, L, along, pts });
  }
  st.risk = st.distance ? st.riskSum / st.distance : 0;
  delete st.riskSum;
  return { stats: st, coords, segments, steps: buildSteps(parts, st.distance, coords), settled: res.settled };
}

// ------------------------------------------------------------------ turn-by-turn

const CARDINALS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const MIN_STEP = 20;      // metres; shorter connectors fold into the next instruction
const SAME_ROAD_TURN = 40; // unnamed segments of the same kind merge if the turn is gentler than this
const STRAIGHT_NAMED_MIN = 60; // a straight-on name change shorter than this is not announced

/** Travel bearing (degrees clockwise from north) over the first or last `dist` metres of pts. */
function bearingAlong(pts, atStart, dist = 15) {
  const P = G.meta.projection;
  const xy = (p) => [(p[0] - P.lon0) * P.kx, (p[1] - P.lat0) * P.ky];
  const n = pts.length;
  const idx = (i) => (atStart ? i : n - 1 - i);
  const a = xy(pts[idx(0)]);
  let b = a, prev = a, acc = 0;
  for (let i = 1; i < n; i++) {
    const q = xy(pts[idx(i)]);
    acc += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
    prev = b = q;
    if (acc >= dist) break;
  }
  const dx = atStart ? b[0] - a[0] : a[0] - b[0];
  const dy = atStart ? b[1] - a[1] : a[1] - b[1];
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}
const turnAngle = (from, to) => ((to - from + 540) % 360) - 180; // positive = right

function partLabel(e) {
  const { S, flags: F, meta } = G;
  const name = G.names[S.edge_name[e]] || '';
  const kind = S.edge_kind[e];
  const crossing = kind === meta.crossing_kind;
  if (name) return { name, label: name, crossing };
  if ((S.edge_flags[e] >> F.footbridge) & 1) return { name, label: 'the foot overbridge', crossing };
  if ((S.edge_flags[e] >> F.underpass) & 1) return { name, label: 'the underpass', crossing };
  return { name, label: meta.kind_labels[kind], crossing };
}

function turnPhrase(turn) {
  const a = Math.abs(turn), dir = turn > 0 ? 'right' : 'left';
  if (a < 20) return 'Continue';
  if (a < 55) return `Slight ${dir}`;
  if (a < 135) return `Turn ${dir}`;
  if (a < 170) return `Sharp ${dir}`;
  return 'Turn around';
}

/** Group route parts into instructions: a new step starts where the street changes or the path turns. */
function buildSteps(parts, total, coords) {
  const steps = [];
  for (const p of parts) {
    const lab = partLabel(p.e);
    const cur = steps[steps.length - 1];
    const sb = bearingAlong(p.pts, true);
    if (cur) {
      const turn = turnAngle(bearingAlong(cur.pts, false), sb);
      const same = !lab.crossing && !cur.crossing && (lab.name
        ? lab.name === cur.name
        : !cur.name && lab.label === cur.label && Math.abs(turn) < SAME_ROAD_TURN);
      if (same) { cur.length += p.L; cur.pts.push(...p.pts.slice(1)); continue; }
      steps.push({ ...lab, turn, along: p.along, length: p.L, pts: p.pts.slice() });
    } else {
      steps.push({ ...lab, turn: 0, along: 0, length: p.L, pts: p.pts.slice(), bearing: sb });
    }
  }

  // Fold short connectors (and straight-through crossings) into the following step, keeping the net turn.
  for (let i = steps.length - 2; i >= 1; i--) {
    const s = steps[i], nx = steps[i + 1];
    const fold = s.crossing ? Math.abs(s.turn) < 45 : s.length < MIN_STEP;
    if (!fold) continue;
    nx.turn = turnAngle(0, s.turn + nx.turn);
    nx.along = s.along;
    nx.length += s.length;
    nx.pts = [...s.pts, ...nx.pts.slice(1)];
    steps.splice(i, 1);
  }
  // A very short first step takes the label of the street it leads onto.
  if (steps.length > 1 && steps[0].length < MIN_STEP && !steps[1].crossing) {
    const [a, b] = steps;
    steps.splice(0, 2, { ...b, turn: 0, along: 0, length: a.length + b.length, pts: [...a.pts, ...b.pts.slice(1)], bearing: a.bearing });
  }
  // Going straight on isn't worth an instruction when the next stretch is unnamed or short
  // (OSM often breaks a road's name for a block); after that, neighbours may be the same street again.
  const mergeBack = (test) => {
    for (let i = steps.length - 1; i >= 1; i--) {
      const s = steps[i], pv = steps[i - 1];
      if (s.crossing || pv.crossing || !test(s, pv)) continue;
      pv.length += s.length;
      pv.pts.push(...s.pts.slice(1));
      steps.splice(i, 1);
    }
  };
  mergeBack((s) => Math.abs(s.turn) < 20 && (!s.name || s.length < STRAIGHT_NAMED_MIN));
  mergeBack((s, pv) => Math.abs(s.turn) < SAME_ROAD_TURN &&
    (s.name ? s.name === pv.name : !pv.name && s.label === pv.label));

  const out = steps.map((s, i) => {
    let text, type = 'turn';
    if (i === 0) {
      type = 'depart';
      text = `Head ${CARDINALS[Math.round(s.bearing / 45) % 8]} on ${s.label}`;
    } else if (s.crossing) {
      type = 'cross';
      text = Math.abs(s.turn) < 20 ? 'Cross the road' : `${turnPhrase(s.turn)} and cross the road`;
    } else {
      const ph = turnPhrase(s.turn);
      text = ph === 'Continue' ? `Continue onto ${s.label}` : ph === 'Turn around' ? `Turn around and walk along ${s.label}` : `${ph} onto ${s.label}`;
    }
    return { type, turn: Math.round(s.turn), text, along: s.along, length: s.length, lon: s.pts[0][0], lat: s.pts[0][1] };
  });
  const end = coords[coords.length - 1];
  if (end) out.push({ type: 'arrive', turn: 0, text: 'Arrive at your destination', along: total, length: 0, lon: end[0], lat: end[1] });
  return out;
}

/** Walking distance (metres, on the safety-weighted route) from one point to each target; null if unreachable. */
function distances({ from, targets, alpha, band }) {
  if (!G) return { error: 'The map data is still loading.' };
  const s = snap(from[0], from[1]);
  if (!s) return { error: 'You are too far from any walkable street in Delhi.' };
  return {
    distances: targets.map(([lon, lat]) => {
      const t = snap(lon, lat, 200);
      const res = t && search(s, t, alpha, band);
      return res ? Math.round(res.pieces.reduce((d, [, a, b]) => d + Math.abs(b - a), 0) + t.d) : null;
    }),
  };
}

function route({ from, to, alpha, band }) {
  if (!G) return { error: 'The map data is still loading.' };
  const s = snap(from[0], from[1]);
  const t = snap(to[0], to[1]);
  if (!s) return { error: 'The start point is too far from any walkable street in Delhi.' };
  if (!t) return { error: 'The destination is too far from any walkable street in Delhi.' };
  const t0 = performance.now();
  const safe = search(s, t, alpha, band);
  const short = alpha > 0 ? search(s, t, 0, band) : safe;
  if (!safe || !short) return { error: 'No walking route found between these points.' };
  return {
    safest: describe(safe, band),
    shortest: describe(short, band),
    snapped: { from: [s.lon, s.lat, s.d], to: [t.lon, t.lat, t.d] },
    ms: Math.round(performance.now() - t0),
  };
}
