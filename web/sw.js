/* Offline support. Network first, so app code and street data always update together;
 * the cached copy is only used when offline. Normal HTTP caching (ETags) keeps repeat
 * visits cheap. */
const CACHE = 'delhi-safe-routes-v5';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'router.worker.js', 'nav.js', 'safety.js', 'demo.js', 'icon.svg', 'manifest.webmanifest',
  'data/meta.json', 'data/names.json', 'data/graph.bin.gz', 'data/places.json', 'data/boundary.json'];

self.addEventListener('install', (e) => e.waitUntil(
  caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // tiles, search: network only
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
