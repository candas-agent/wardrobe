// Offline support. App files: network-first (updates arrive when online), cache fallback.
// 'no-cache' revalidates with the server instead of using the browser's HTTP cache (GitHub Pages: 10 min).
// The AI models are cached separately by models.js.
//
// Cross-origin isolation: GitHub Pages can't send the COOP/COEP headers that multi-threaded
// onnxruntime needs (SharedArrayBuffer), so this worker adds them to every response. onnxruntime
// itself is served same-origin under ./ort/ (fetched from the CDN, cache-first), because its
// thread workers must come from the page's own origin.

const CACHE = 'wardrobe-app-v8';
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'db.js', 'catalog.js', 'classify.js', 'models.js', 'segment.js', 'fingerprint.js', 'labels.json',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

const ORT_FILES = ['ort.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' }))))
    // onnxruntime too, so the AI helpers work offline; not fatal if the CDN is unreachable right now
    .then(() => Promise.all(ORT_FILES.map(f => cachedOrt(f).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('wardrobe-app-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function isolated(res) {
  if (res.type === 'opaqueredirect' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function cachedOrt(name) {
  const url = ORT_CDN + name;
  const cache = await caches.open(CACHE);
  let res = await cache.match(url);
  if (!res) {
    res = await fetch(url);
    if (res.ok) await cache.put(url, res.clone());
  }
  return res;
}

async function ortFile(name) {
  const res = await cachedOrt(name);
  // re-wrap so the response belongs to this origin (worker scripts must be same-origin)
  const type = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
  return isolated(new Response(await res.blob(), { status: res.status, headers: { 'Content-Type': type } }));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // models (Hugging Face) are fetched with CORS, nothing to do

  const ortPrefix = new URL('ort/', self.registration.scope).pathname;
  if (url.pathname.startsWith(ortPrefix)) {
    e.respondWith(ortFile(url.pathname.slice(ortPrefix.length)));
    return;
  }

  e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
    return isolated(res);
  }).catch(async () => isolated((await caches.match(req, { ignoreSearch: true })) ?? await caches.match('index.html'))));
});
