/* Delhi Safe Routes: map UI. Routing happens in router.worker.js. */
'use strict';

const DATA = 'data/';
const DELHI_BBOX = [76.83, 28.40, 77.35, 28.89];
const WALK_KMH = 4.5;
const LEVEL_COLORS = ['#16a34a', '#f59e0b', '#dc2626'];
const POLICE_COLOR = '#1d4ed8';
const HOSPITAL_COLOR = '#be123c';
const PLACES_MINZOOM = 12;
const $ = (sel, root = document) => root.querySelector(sel);

const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const state = { from: null, to: null, band: 0, alpha: 1, bands: [], places: [], showShortest: true, last: null };

// ------------------------------------------------------------------ map

const map = new maplibregl.Map({
  container: 'map',
  style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
  center: [77.17, 28.63],
  zoom: 10.2,
  minZoom: 9,
  maxBounds: [[76.5, 28.2], [77.7, 29.1]],
  attributionControl: { compact: true, customAttribution: 'Search: <a href="https://photon.komoot.io">Photon</a>' },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
if (innerWidth > 720) map.setPadding({ left: 412, top: 20, right: 20, bottom: 20 });
else map.setPadding({ bottom: innerHeight * 0.5, top: 20, left: 10, right: 10 });

const mapReady = new Promise((resolve) => map.on('load', resolve));

// Resolves once our own sources and layers exist
const layersReady = mapReady.then(async () => {
  const [boundary, places] = await Promise.all([
    fetch(DATA + 'boundary.json').then((r) => r.json()),
    fetch(DATA + 'places.json').then((r) => r.json()),
  ]);
  state.places = places;

  // Dim everything outside Delhi NCT
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const rings = boundary.type === 'Polygon' ? [boundary.coordinates[0]] : boundary.coordinates.map((p) => p[0]);
  map.addSource('mask', { type: 'geojson', data: { type: 'Polygon', coordinates: [world, ...rings] } });
  map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': dark ? '#000' : '#6b7c77', 'fill-opacity': 0.18 } });
  map.addSource('boundary', { type: 'geojson', data: boundary });
  map.addLayer({ id: 'boundary', type: 'line', source: 'boundary', paint: { 'line-color': '#0f766e', 'line-width': 1.5, 'line-opacity': 0.6 } });

  map.addSource('places', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: places.map((p) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })) },
  });
  map.addLayer({
    id: 'police', type: 'circle', source: 'places', minzoom: PLACES_MINZOOM,
    filter: ['==', ['get', 'k'], 'police'],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 16, 7], 'circle-color': POLICE_COLOR, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
  });
  map.addImage('hospital-plus', hospitalIcon(), { pixelRatio: 2 });
  map.addLayer({
    id: 'hospitals', type: 'symbol', source: 'places', minzoom: PLACES_MINZOOM,
    filter: ['==', ['get', 'k'], 'hospital'],
    layout: { 'icon-image': 'hospital-plus', 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 1], 'icon-allow-overlap': true },
  });
  const placeLayers = ['police', 'hospitals'];
  map.on('click', placeLayers, (e) => {
    const p = e.features[0].properties;
    const kind = { police: 'Police', hospital: 'Hospital' }[p.k];
    new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(`<b>${escapeHtml(kind)}</b><br>${escapeHtml(p.n || '')}`).addTo(map);
    e.preventDefault();
  });
  map.on('mouseenter', placeLayers, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', placeLayers, () => { map.getCanvas().style.cursor = ''; });
  const syncKeyHint = () => { $('#map-key .hint').hidden = map.getZoom() >= PLACES_MINZOOM; };
  map.on('zoomend', syncKeyHint);
  syncKeyHint();

  map.addSource('shortest', { type: 'geojson', data: emptyFC() });
  map.addSource('safest', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'shortest', type: 'line', source: 'shortest', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#64748b', 'line-width': 4, 'line-dasharray': [1.2, 1.4], 'line-opacity': 0.85 } });
  map.addLayer({ id: 'safest-casing', type: 'line', source: 'safest', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': dark ? '#0b1210' : '#ffffff', 'line-width': 9 } });
  map.addLayer({ id: 'safest', type: 'line', source: 'safest', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'level'], 0, LEVEL_COLORS[0], 1, LEVEL_COLORS[1], LEVEL_COLORS[2]], 'line-width': 5.5 } });
});

map.on('click', (e) => {
  if (e.defaultPrevented) return;
  const pt = [+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)];
  setPoint(state.from ? 'to' : 'from', pt, 'Dropped pin');
});

const markers = {};
function setPoint(which, lonlat, label) {
  state[which] = lonlat;
  $(`#${which}`).value = label || '';
  if (!markers[which]) {
    const el = document.createElement('div');
    el.className = `marker ${which}`;
    el.innerHTML = `<span>${which === 'from' ? 'A' : 'B'}</span>`;
    markers[which] = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom-left', offset: [-4, 4] })
      .setLngLat(lonlat).addTo(map);
    markers[which].on('dragend', () => {
      const ll = markers[which].getLngLat();
      state[which] = [+ll.lng.toFixed(6), +ll.lat.toFixed(6)];
      $(`#${which}`).value = 'Dropped pin';
      requestRoute();
    });
  } else {
    markers[which].setLngLat(lonlat);
  }
  requestRoute(true);
}

// ------------------------------------------------------------------ worker

const worker = new Worker('router.worker.js');
let ready = false, reqId = 0, fitNext = false;
worker.postMessage({ type: 'load', base: new URL(DATA, location.href).href });
worker.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    const pct = data.total ? Math.min(100, (data.got / data.total) * 100) : 50;
    $('#status .fill').style.width = pct.toFixed(0) + '%';
    $('#status .msg').textContent = `Loading Delhi street data… ${(data.got / 1e6).toFixed(1)} MB`;
  } else if (data.type === 'ready') {
    ready = true;
    const osm = data.osm ? new Date(data.osm).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '?';
    $('#data-info').textContent = `Street data: © OpenStreetMap contributors, updated ${osm}. ${data.edges.toLocaleString('en-IN')} street segments.`;
    showStatus(state.from ? '' : 'Tap the map or search to set a start point.');
    requestRoute(true);
  } else if (data.type === 'route') {
    if (data.id !== reqId) return; // a newer request is in flight
    if (data.error) { showStatus(data.error, true); clearRoute(); return; }
    showStatus('');
    renderRoute(data);
  } else if (data.type === 'error') {
    showStatus(`Something went wrong: ${data.message}`, true);
  }
};

function requestRoute(fit = false) {
  if (!ready || !state.from || !state.to) return;
  fitNext = fitNext || fit;
  worker.postMessage({ type: 'route', id: ++reqId, from: state.from, to: state.to, alpha: state.alpha, band: state.band });
}

function showStatus(msg, isError = false) {
  const el = $('#status');
  el.hidden = !msg;
  el.classList.toggle('error', isError);
  $('.msg', el).textContent = msg;
  if (ready) $('.bar', el).style.display = 'none';
}

// ------------------------------------------------------------------ rendering

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

function clearRoute() {
  $('#result').hidden = true;
  layersReady.then(() => { map.getSource('safest').setData(emptyFC()); map.getSource('shortest').setData(emptyFC()); });
}

async function renderRoute(res) {
  state.last = res;
  const safe = res.safest, short = res.shortest;
  const same = Math.abs(safe.stats.distance - short.stats.distance) < 5;
  $('#result').innerHTML = resultHtml(safe, short, same);
  $('#result').hidden = false;
  $('#show-shortest')?.addEventListener('change', (e) => { state.showShortest = e.target.checked; renderRoute(state.last); });

  await layersReady; // the directions above don't need to wait for the basemap
  if (state.last !== res) return;
  map.getSource('safest').setData({
    type: 'FeatureCollection',
    features: safe.segments.map((s) => ({ type: 'Feature', properties: { level: s.level }, geometry: { type: 'LineString', coordinates: s.coords } })),
  });
  map.getSource('shortest').setData(same || !state.showShortest || state.alpha === 0 ? emptyFC()
    : { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: short.coords } });

  if (fitNext) {
    const b = new maplibregl.LngLatBounds();
    [...safe.coords, ...(same ? [] : short.coords)].forEach((c) => b.extend(c));
    map.fitBounds(b, { maxZoom: 16.5, duration: 600, padding: 60 });
    fitNext = false;
  }
}

const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const mins = (m) => `${Math.max(1, Math.round(m / 1000 / WALK_KMH * 60))} min`;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const score = (s) => Math.round(s.risk * 100);

function resultHtml(safe, short, same) {
  const s = safe.stats, band = state.bands[state.band];
  const night = band.id !== 'day';
  const extra = s.distance - short.stats.distance;
  const title = state.alpha === 0 ? 'Shortest route' : 'Safer route';
  const compare = state.alpha === 0 ? '' : same
    ? '<div class="compare">The shortest route is already the safest option here.</div>'
    : `<div class="compare"><b>${extra >= 0 ? '+' : ''}${km(extra)}</b> (${pct(extra, short.stats.distance)}%) longer than the shortest route,
       exposure <b>${score(s)}</b> vs <b>${score(short.stats)}</b>.</div>`;

  const metrics = [
    ['On main roads', pct(s.main, s.distance), '%'],
    night && ['Likely well lit', pct(s.lit, s.distance), '%'],
    ['Within 250 m of a police station', pct(s.nearPolice, s.distance), '%'],
  ].filter(Boolean);

  const open = Math.round(s.open);
  const notes = [];
  if (open >= 1) notes.push(['good', `Passes about ${open} place${open === 1 ? '' : 's'} likely to be open ${band.id === 'day' ? 'during the day' : band.id === 'evening' ? 'in the evening' : 'late at night'} (shops, eateries, pharmacies, fuel stations).`]);
  const police = policeNear(safe.coords, 250);
  if (police.length) notes.push(['good', `Police nearby: ${police.slice(0, 3).map(escapeHtml).join(', ')}${police.length > 3 ? ` and ${police.length - 3} more` : ''}.`]);
  if (s.green > 40) notes.push(['', `${km(s.green)} through a park or green area${night ? ', which may be empty at this hour' : ''}.`]);
  if (s.isolatedLand > 40) notes.push(['', `${km(s.isolatedLand)} through industrial, farm or other isolated land.`]);
  if (s.alongIsolated > 100 && night) notes.push(['', `${km(s.alongIsolated)} alongside a large park, forest or industrial area.`]);
  if (s.underpasses) notes.push(['', `Uses ${s.underpasses} underpass${s.underpasses > 1 ? 'es' : ''} or tunnel${s.underpasses > 1 ? 's' : ''}.`]);
  if (s.footbridges && night) notes.push(['', `Uses ${s.footbridges} foot overbridge${s.footbridges > 1 ? 's' : ''}.`]);
  if (night && s.darkestStretch > 150) notes.push(['', `Longest stretch that may be poorly lit: ${km(s.darkestStretch)}.`]);
  if (s.pathlike > 40) notes.push(['', `${km(s.pathlike)} on unpaved paths or tracks.`]);
  if (s.trunk > 200) notes.push(['', `${km(s.trunk)} along a highway or arterial road with fast traffic.`]);

  return `
    <div>
      <div class="sub-h">${title} · ${escapeHtml(band.label)}</div>
      <div class="summary"><span class="big">${km(s.distance)}</span><span class="mins">${mins(s.distance)} walk</span></div>
      ${compare}
    </div>
    <div class="score"><span class="num" style="color:${riskColor(s.risk)}">${score(s)}</span>
      <span class="txt"><b>Exposure score</b> (0 to 100, lower is better) based on lighting, activity, road type and isolation along the route.</span></div>
    <ul class="metrics">${metrics.map(([k, v]) => `<li class="metric"><span>${k}</span><span class="v">${v}%</span><span class="track"><i style="width:${v}%"></i></span></li>`).join('')}</ul>
    ${notes.length ? `<ul class="notes">${notes.map(([c, t]) => `<li class="${c}">${t}</li>`).join('')}</ul>` : ''}
    <div class="legend">
      <span><i style="background:${LEVEL_COLORS[0]}"></i>Lower exposure</span>
      <span><i style="background:${LEVEL_COLORS[1]}"></i>Moderate</span>
      <span><i style="background:${LEVEL_COLORS[2]}"></i>Higher</span>
      ${same || state.alpha === 0 ? '' : '<span><i class="dash"></i>Shortest</span>'}
    </div>
    ${same || state.alpha === 0 ? '' : `<label class="toggle"><input type="checkbox" id="show-shortest" ${state.showShortest ? 'checked' : ''}> Show shortest route for comparison</label>`}
  `;
}

/** Hospital marker: white "+" on a rounded square, drawn at 2x for sharp rendering. */
function hospitalIcon() {
  const s = 36, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath(); g.roundRect(0, 0, s, s, 9); g.fill();
  g.fillStyle = HOSPITAL_COLOR;
  g.beginPath(); g.roundRect(3, 3, s - 6, s - 6, 7); g.fill();
  g.fillStyle = '#fff';
  g.fillRect(15, 8, 6, 20);
  g.fillRect(8, 15, 20, 6);
  return g.getImageData(0, 0, s, s);
}

function riskColor(r) { return r < 0.25 ? 'var(--safe)' : r < 0.45 ? 'var(--warn)' : 'var(--risk)'; }

function policeNear(coords, radius) {
  const kx = 111320 * Math.cos((28.61 * Math.PI) / 180), ky = 110540;
  const names = [];
  for (const p of state.places) {
    if (p.k !== 'police') continue;
    for (let i = 0; i < coords.length; i += 2) {
      const dx = (coords[i][0] - p.lon) * kx, dy = (coords[i][1] - p.lat) * ky;
      if (dx * dx + dy * dy < radius * radius) { names.push(p.n || 'Police station'); break; }
    }
  }
  return [...new Set(names)];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ controls

fetch(DATA + 'meta.json').then((r) => r.json()).then((meta) => {
  state.bands = meta.bands;
  const h = new Date().getHours();
  const inBand = (b) => (b.end > b.start ? h >= b.start && h < b.end : h >= b.start || h < b.end);
  const now = Math.max(0, meta.bands.findIndex(inBand));
  state.band = now;
  const seg = $('#bands');
  meta.bands.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', i === now);
    btn.innerHTML = `${escapeHtml(b.label.split(' (')[0])}${i === now ? '<span class="now">now</span>' : ''}`;
    btn.title = b.label;
    btn.onclick = () => {
      state.band = i;
      seg.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-checked', j === i));
      requestRoute();
    };
    seg.appendChild(btn);
  });
});

let alphaTimer;
$('#alpha').addEventListener('input', (e) => {
  state.alpha = +e.target.value / 100;
  clearTimeout(alphaTimer);
  alphaTimer = setTimeout(() => requestRoute(), 120);
});

$('#swap').onclick = () => {
  if (!state.from && !state.to) return;
  const f = { ll: state.from, label: $('#from').value }, t = { ll: state.to, label: $('#to').value };
  [state.from, state.to] = [t.ll, f.ll];
  $('#from').value = t.label; $('#to').value = f.label;
  for (const w of ['from', 'to']) {
    if (state[w] && markers[w]) markers[w].setLngLat(state[w]);
    else if (state[w]) setPoint(w, state[w], $(`#${w}`).value);
    else if (markers[w]) { markers[w].remove(); delete markers[w]; }
  }
  requestRoute();
};

$('#locate').onclick = () => {
  if (!navigator.geolocation) return showStatus('Location is not available in this browser.', true);
  showStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const ll = [+pos.coords.longitude.toFixed(6), +pos.coords.latitude.toFixed(6)];
      setPoint('from', ll, 'My location');
      if (!state.to) { showStatus('Now choose a destination.'); map.flyTo({ center: ll, zoom: 15 }); }
    },
    () => showStatus('Could not get your location. Check location permission.', true),
    { enableHighAccuracy: true, timeout: 10000 },
  );
};

// Place search (Photon, restricted to Delhi)
for (const which of ['from', 'to']) {
  const input = $(`#${which}`);
  const list = input.parentElement.querySelector('.suggest');
  let timer, items = [], active = -1, ctrl;
  const close = () => { list.innerHTML = ''; items = []; active = -1; };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    setPoint(which, it.ll, it.name);
    if (!(state.from && state.to)) map.flyTo({ center: it.ll, zoom: 15 });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&bbox=${DELHI_BBOX.join(',')}&lat=28.61&lon=77.21`;
        const fc = await (await fetch(url, { signal: ctrl.signal })).json();
        items = fc.features.map((f) => {
          const p = f.properties;
          const sub = [p.street, p.district || p.locality, p.city || p.county].filter(Boolean).filter((x) => x !== p.name).join(', ');
          return { name: p.name || p.street || 'Unnamed place', sub, ll: f.geometry.coordinates };
        });
        active = -1;
        list.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}">${escapeHtml(it.name)}<span class="sub">${escapeHtml(it.sub)}</span></li>`).join('')
          || '<li class="sub">No matches in Delhi</li>';
      } catch (err) {
        if (err.name !== 'AbortError') list.innerHTML = '<li class="sub">Search is unavailable. Tap the map instead.</li>';
      }
    }, 280);
  });
  input.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      list.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', i === active));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(Math.max(0, active));
    } else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); choose(+li.dataset.i); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
