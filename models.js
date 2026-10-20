// On-device models: download once into the Cache API, then run with onnxruntime-web.
// The heavy EdgeSAM image encoder runs on the processor (wasm, multi-threaded when possible). The
// graphics chip (WebGPU) is an opt-in experiment: on an Android test phone it gave wrong outlines and
// froze the phone while being checked, so it's never used unless switched on in Settings.
// Everything else always runs on the processor.

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const CACHE = 'wardrobe-model-v1';
const HF = 'https://huggingface.co/';
const CLIP = `${HF}Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/`;
const EDGESAM = `${HF}chongzhou/EdgeSAM/resolve/e0564124628944e1622973d4e0f68158b46f035a/`;

const MODELS = {
  clip: { url: CLIP + 'vision_model_quantized.onnx', size: 89117001 },
  samEncoder: { url: EDGESAM + 'edge_sam_3x_encoder.onnx', size: 22098300 }, // same file on processor and graphics chip
  samDecoder: { url: EDGESAM + 'edge_sam_3x_decoder.onnx', size: 15937006 },
};

const MODELS_ENCODER_ID = 'edgesam-3x';

let ortPromise;
const sessions = {};
let encoderOnGpu = false;

// With the service worker in control, onnxruntime is loaded through it from ./ort/ (cached, works
// offline); when it has also made the page cross-origin isolated, several threads can be used.
// Before the service worker takes over (very first launch): single-threaded straight from the CDN.
const VIA_SW = !!navigator.serviceWorker?.controller;
export const THREADS = VIA_SW && self.crossOriginIsolated
  ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

// ---- graphics chip

const GPU_PREF = 'wardrobe-gpu'; // localStorage: 'on' (switched on in Settings) | 'failed' (didn't work here); unset = off
const GPU_REASON = 'wardrobe-gpu-reason';
export const gpuFailReason = () => localStorage.getItem(GPU_REASON);
let gpuAvailablePromise;
export function gpuAvailable() {
  gpuAvailablePromise ??= (async () => !!(await navigator.gpu?.requestAdapter().catch(() => null)))();
  return gpuAvailablePromise;
}
// Opt-in since EdgeSAM: earlier settings (on by default, or 'failed' for SlimSAM) are reset to off.
if (localStorage.getItem('wardrobe-gpu-model') !== MODELS_ENCODER_ID) {
  for (const k of [GPU_PREF, 'wardrobe-gpu-config', 'wardrobe-gpu-reason']) localStorage.removeItem(k);
  localStorage.setItem('wardrobe-gpu-model', MODELS_ENCODER_ID);
}
export const gpuState = () => localStorage.getItem(GPU_PREF);
export async function useGpu() { return gpuState() === 'on' && gpuAvailable(); }
export function setGpu(on) {
  on ? localStorage.setItem(GPU_PREF, 'on') : localStorage.removeItem(GPU_PREF);
  localStorage.removeItem(GPU_REASON);
}

// Accuracy check: some phone GPUs run the model without errors but return wrong numbers (wrong
// outlines). Run it on a fixed pattern and compare with reference numbers computed on a CPU
// (tools/make_gpu_check.py). Relative error: ~0.001 expected on a working GPU, the int8 CPU model
// gives 0.045, wrong results 0.14 and more.
const GPU_MAX_ERROR = 0.06;

function testPattern() { // same formula as tools/make_gpu_check.py
  const data = new Float32Array(3 * 1024 * 1024);
  for (let c = 0; c < 3; c++) for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
    data[c * 1048576 + y * 1024 + x] = 1.5 * Math.sin(0.07 * x + 1.3 * c) * Math.cos(0.05 * y) + 0.6 * Math.sin(0.013 * (x + 2 * y) + c);
  }
  return data;
}

export async function checkGpu(ort, session) { // exported for tests; returns the relative error
  const [{ pool, summary: ref }, out] = await Promise.all([
    fetch('gpu-check.json').then(r => r.json()),
    run(session, { image: new ort.Tensor('float32', testPattern(), [1, 3, 1024, 1024]) }, { priority: 1 }),
  ]);
  const emb = await out.image_embeddings.getData(), n = 64 / pool;
  let diff = 0, norm = 0;
  for (let ch = 0; ch < 256; ch++) for (let by = 0; by < n; by++) for (let bx = 0; bx < n; bx++) {
    let sum = 0;
    for (let y = by * pool; y < (by + 1) * pool; y++) for (let x = bx * pool; x < (bx + 1) * pool; x++) sum += emb[ch * 4096 + y * 64 + x];
    const v = sum / (pool * pool), r = ref[(ch * n + by) * n + bx];
    diff += (v - r) ** 2;
    norm += r * r;
  }
  return Math.sqrt(diff / norm); // relative error, NaN if the GPU returned NaNs
}

// Only the normal configuration: trying safer (unoptimised, much heavier) ones one after another
// froze the Android test phone.
const GPU_CONFIGS = [
  { name: 'normal', providers: ['webgpu'], options: {} },
];
const GPU_CONFIG = 'wardrobe-gpu-config'; // localStorage: name of the config that passed last time

async function gpuName() {
  const info = (await navigator.gpu?.requestAdapter().catch(() => null))?.info;
  return [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'unknown GPU';
}

// Tries the configs (last good one first) until one passes the accuracy check.
async function gpuEncoderSession() {
  const ort = await getOrt();
  const last = localStorage.getItem(GPU_CONFIG);
  const order = [...GPU_CONFIGS].sort((a, b) => (b.name === last) - (a.name === last));
  const results = [];
  for (const cfg of order) {
    let s;
    try {
      s = await createSession(MODELS.samEncoder, cfg.providers, cfg.options);
      const error = await checkGpu(ort, s); // also compiles the shaders, so the first photo is quick
      results.push(`${cfg.name} ${Number.isFinite(error) ? error.toFixed(2) : 'NaN'}`);
      if (error < GPU_MAX_ERROR) {
        console.info(`WebGPU encoder: ${cfg.name} config passed the accuracy check (error ${error.toFixed(4)})`);
        localStorage.setItem(GPU_CONFIG, cfg.name);
        localStorage.setItem(GPU_REASON, `${await gpuName()}; check: ${results.join(', ')}`);
        return s;
      }
    } catch (err) {
      results.push(`${cfg.name} failed (${err.message?.slice(0, 60)})`);
    }
    await s?.release?.().catch(() => {});
  }
  localStorage.removeItem(GPU_CONFIG);
  throw new Error(`the graphics chip's results were inaccurate (${await gpuName()}; check: ${results.join(', ')})`);
}
export const isEncoderOnGpu = () => encoderOnGpu;

// The encoder failed on the graphics chip: remember it and use the processor from now on.
function markGpuFailed(err) {
  console.warn('WebGPU encoder failed, using the processor', err);
  localStorage.setItem(GPU_PREF, 'failed');
  localStorage.setItem(GPU_REASON, err?.message ?? String(err));
  encoderOnGpu = false;
}
export function gpuFailed(err) { // during a run: also drop the GPU session so the next one is on the processor
  markGpuFailed(err);
  delete sessions.samEncoder;
}

export function getOrt() {
  ortPromise ??= useGpu().then(async gpu => {
    const base = VIA_SW ? new URL('ort/', location.href).href : ORT_BASE;
    const ort = await import(`${base}${gpu ? 'ort.webgpu.min.mjs' : 'ort.min.mjs'}`);
    ort.env.wasm.wasmPaths = base;
    ort.env.wasm.numThreads = THREADS;
    return ort;
  });
  return ortPromise;
}

// ---- download

async function required() {
  return Object.values(MODELS);
}

// Removes cached models the app no longer uses (e.g. SlimSAM, before EdgeSAM replaced it).
async function pruneOldModels() {
  const cache = await caches.open(CACHE), wanted = new Set(Object.values(MODELS).map(m => m.url));
  for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
}

export async function modelsDownloaded() {
  const cache = await caches.open(CACHE);
  const hits = await Promise.all((await required()).map(m => cache.match(m.url)));
  return hits.every(Boolean);
}

// MB still to download (what the progress bar shows), and MB of everything this device uses.
export async function missingMB() {
  const cache = await caches.open(CACHE);
  let bytes = 0;
  for (const m of await required()) if (!(await cache.match(m.url))) bytes += m.size;
  return Math.round(bytes / 1e6);
}
export async function totalMB() {
  return Math.round((await required()).reduce((s, m) => s + m.size, 0) / 1e6);
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

// Downloads whatever isn't cached yet. onProgress gets 0..1 over what's missing.
async function downloadModels(onProgress) {
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const m of await required()) if (!(await cache.match(m.url))) missing.push(m);
  const total = missing.reduce((s, m) => s + m.size, 0);
  let done = 0;
  for (const m of missing) await fetchInto(cache, m, n => { done += n; onProgress?.(Math.min(1, done / total)); });
  onProgress?.(1);
  await pruneOldModels().catch(() => {});
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

// ---- sessions

async function createSession(model, executionProviders, options = {}) {
  const [ort, cache] = await Promise.all([getOrt(), caches.open(CACHE)]);
  const res = await cache.match(model.url);
  if (!res) throw new Error('Models not downloaded');
  return ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders, ...options });
}

async function encoderSession() {
  if (await useGpu()) {
    try {
      const s = await gpuEncoderSession();
      encoderOnGpu = true;
      return s;
    } catch (err) { markGpuFailed(err); }
  }
  return createSession(MODELS.samEncoder, ['wasm']);
}

export function getSession(name) {
  sessions[name] ??= (async () => {
    await ensureModels(); // waits for an ongoing download
    return name === 'samEncoder' ? encoderSession() : createSession(MODELS[name], ['wasm']);
  })();
  sessions[name].catch(() => { delete sessions[name]; });
  return sessions[name];
}

// Creates the sessions ahead of time (e.g. while the photo picker is open) so the first photo is fast.
export async function warmUp() {
  if (!(await modelsDownloaded().catch(() => false))) return;
  for (const name of ['samDecoder', 'samEncoder', 'clip']) await getSession(name).catch(() => {});
}

// Human-readable "where does the AI run" for Settings.
export async function backendLabel() {
  if (await useGpu()) return 'graphics chip (WebGPU)';
  return `processor (${THREADS} core${THREADS > 1 ? 's' : ''})`;
}

// ---- job queue

// Inference runs one job at a time. Jobs wait in a queue; higher priority goes first (a tap's outline
// before type detection), and a job whose result is no longer wanted (stale()) is dropped before it starts.
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
