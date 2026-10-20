// On-device models: download once into the Cache API, then run with onnxruntime-web (wasm).

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const CACHE = 'wardrobe-model-v1';
const HF = 'https://huggingface.co/';
const CLIP = `${HF}Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/`;
const SAM = `${HF}Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/`;

const MODELS = {
  clip: { url: CLIP + 'vision_model_quantized.onnx', size: 89117001 },
  samEncoder: { url: SAM + 'vision_encoder_quantized.onnx', size: 8882165 },
  samDecoder: { url: SAM + 'prompt_encoder_mask_decoder_quantized.onnx', size: 4903810 },
};
export const TOTAL_MB = Math.round(Object.values(MODELS).reduce((s, m) => s + m.size, 0) / 1e6);

let ortPromise;
const sessions = {};

// With the service worker in control, onnxruntime is loaded through it from ./ort/ (cached, works
// offline); when it has also made the page cross-origin isolated, several threads can be used.
// Before the service worker takes over (very first launch): single-threaded straight from the CDN.
const VIA_SW = !!navigator.serviceWorker?.controller;
export const THREADS = VIA_SW && self.crossOriginIsolated
  ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

export function getOrt() {
  const base = VIA_SW ? new URL('ort/', location.href).href : ORT_BASE;
  ortPromise ??= import(`${base}ort.min.mjs`).then(ort => {
    ort.env.wasm.wasmPaths = base;
    ort.env.wasm.numThreads = THREADS;
    return ort;
  });
  return ortPromise;
}

export async function modelsDownloaded() {
  const cache = await caches.open(CACHE);
  const hits = await Promise.all(Object.values(MODELS).map(m => cache.match(m.url)));
  return hits.every(Boolean);
}

async function fetchInto(cache, model, onBytes) {
  const res = await fetch(model.url);
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  const reader = res.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.length);
  }
  await cache.put(model.url, new Response(new Blob(chunks), { headers: { 'content-type': 'application/octet-stream' } }));
}

// Downloads whatever isn't cached yet. onProgress gets 0..1 over all models.
async function downloadModels(onProgress) {
  const cache = await caches.open(CACHE);
  const all = Object.values(MODELS);
  const total = all.reduce((s, m) => s + m.size, 0);
  let done = 0;
  for (const m of all) {
    if (await cache.match(m.url)) { done += m.size; continue; }
    await fetchInto(cache, m, n => { done += n; onProgress?.(Math.min(1, done / total)); });
  }
  onProgress?.(1);
}

// Starts (or joins) the one-time download. Listeners get progress 0..1.
let readyPromise;
const listeners = new Set();
export function ensureModels(onProgress) {
  if (onProgress) listeners.add(onProgress);
  readyPromise ??= downloadModels(p => listeners.forEach(f => f(p)));
  readyPromise.catch(() => { readyPromise = undefined; });
  return readyPromise;
}

export function getSession(name) {
  sessions[name] ??= (async () => {
    await ensureModels(); // waits for an ongoing download
    const [ort, cache] = await Promise.all([getOrt(), caches.open(CACHE)]);
    const res = await cache.match(MODELS[name].url);
    if (!res) throw new Error('Models not downloaded');
    const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
    return session;
  })();
  sessions[name].catch(() => { delete sessions[name]; });
  return sessions[name];
}

// Creates the sessions ahead of time (e.g. while the photo picker is open) so the first photo is fast.
export async function warmUp() {
  if (!(await modelsDownloaded().catch(() => false))) return;
  for (const name of ['samDecoder', 'samEncoder', 'clip']) await getSession(name).catch(() => {});
}

// The wasm backend runs one inference at a time. Jobs wait in a queue; higher priority goes first
// (a tap's outline before type detection), and a job whose result is no longer wanted (stale()) is
// dropped before it starts.
export class StaleError extends Error {}
const pending = [];
let running = false;
export function run(session, feeds, { priority = 0, stale } = {}) {
  return new Promise((resolve, reject) => {
    pending.push({ session, feeds, priority, stale, resolve, reject });
    pending.sort((a, b) => b.priority - a.priority); // stable: first-come first-served within a priority
    pump();
  });
}
async function pump() {
  if (running || !pending.length) return;
  const job = pending.shift();
  if (job.stale?.()) { job.reject(new StaleError()); return pump(); }
  running = true;
  try { job.resolve(await job.session.run(job.feeds)); }
  catch (err) { job.reject(err); }
  finally { running = false; pump(); }
}
