// Offline support. App files: network-first (updates arrive when online), cache fallback.
// onnxruntime from the CDN: cache-first (version-pinned URLs never change).
// The CLIP model is cached separately by classify.js.

const CACHE = 'wardrobe-app-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'db.js', 'catalog.js', 'classify.js', 'models.js', 'segment.js', 'labels.json',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('wardrobe-app-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(async () => (await caches.match(req, { ignoreSearch: true })) ?? caches.match('index.html')));
  }
});
