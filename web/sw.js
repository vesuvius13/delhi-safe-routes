/* Offline support: serve the app shell and street data from cache, refresh in the background. */
const CACHE = 'delhi-safe-routes-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'router.worker.js', 'nav.js', 'icon.svg', 'manifest.webmanifest',
  'data/meta.json', 'data/names.json', 'data/graph.bin.gz', 'data/places.json', 'data/boundary.json'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // tiles, search: network only
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request);
    const fresh = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => cached);
    return cached || fresh;
  }));
});
