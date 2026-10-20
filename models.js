// On-device models: download once into the Cache API, then run with onnxruntime-web.
// The heavy SAM image encoder runs on the graphics chip (WebGPU) when the device has one, else on
// the processor (wasm, multi-threaded when possible). Everything else always runs on the processor.

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const CACHE = 'wardrobe-model-v1';
const HF = 'https://huggingface.co/';
const CLIP = `${HF}Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/`;
const SAM = `${HF}Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/`;

const MODELS = {
  clip: { url: CLIP + 'vision_model_quantized.onnx', size: 89117001 },
  samEncoder: { url: SAM + 'vision_encoder_quantized.onnx', size: 8882165 },
  // full precision for the graphics chip: the int8 model's integer ops would fall back to the processor
  samEncoderFull: { url: SAM + 'vision_encoder.onnx', size: 23276014 },
  samDecoder: { url: SAM + 'prompt_encoder_mask_decoder_quantized.onnx', size: 4903810 },
};

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

const GPU_PREF = 'wardrobe-gpu'; // localStorage: 'off' (switched off in Settings) | 'failed' (didn't work here)
const GPU_REASON = 'wardrobe-gpu-reason';
export const gpuFailReason = () => localStorage.getItem(GPU_REASON);
let gpuAvailablePromise;
export function gpuAvailable() {
  gpuAvailablePromise ??= (async () => !!(await navigator.gpu?.requestAdapter().catch(() => null)))();
  return gpuAvailablePromise;
}
export const gpuState = () => localStorage.getItem(GPU_PREF);
export async function useGpu() { return !gpuState() && gpuAvailable(); }
export function setGpu(on) {
  on ? localStorage.removeItem(GPU_PREF) : localStorage.setItem(GPU_PREF, 'off');
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

export async function checkGpu(ort, session) { // exported for tests
  const [{ pool, summary: ref }, out] = await Promise.all([
    fetch('gpu-check.json').then(r => r.json()),
    run(session, { pixel_values: new ort.Tensor('float32', testPattern(), [1, 3, 1024, 1024]) }, { priority: 1 }),
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
  const error = Math.sqrt(diff / norm);
  if (!(error < GPU_MAX_ERROR)) throw new Error(`the graphics chip's results were inaccurate (error ${error.toFixed(2)})`);
  console.info(`WebGPU accuracy check passed (error ${error.toFixed(4)})`);
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
  return ['clip', (await useGpu()) ? 'samEncoderFull' : 'samEncoder', 'samDecoder'].map(k => MODELS[k]);
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

async function createSession(model, executionProviders) {
  const [ort, cache] = await Promise.all([getOrt(), caches.open(CACHE)]);
  const res = await cache.match(model.url);
  if (!res) throw new Error('Models not downloaded');
  return ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders });
}

async function encoderSession() {
  const cache = await caches.open(CACHE);
  if (await useGpu()) {
    try {
      const s = await createSession(MODELS.samEncoderFull, ['webgpu']);
      await checkGpu(await getOrt(), s); // also compiles the shaders, so the first photo is quick
      encoderOnGpu = true;
      return s;
    } catch (err) { markGpuFailed(err); }
  }
  // processor: the int8 model if we have it, else the full one (same speed on the processor)
  const model = (await cache.match(MODELS.samEncoder.url)) ? MODELS.samEncoder : MODELS.samEncoderFull;
  return createSession(model, ['wasm']);
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
