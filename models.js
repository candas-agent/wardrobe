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

export function getOrt() {
  ortPromise ??= import(`${ORT_BASE}ort.min.mjs`).then(ort => {
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = 1; // GitHub Pages can't send the COOP/COEP headers threads need
    return ort;
  });
  return ortPromise;
}

export async function modelsDownloaded() {
  const cache = await caches.open(CACHE);
  const hits = await Promise.all(Object.values(MODELS).map(m => cache.match(m.url)));
  return hits.every(Boolean);
}

export async function deleteModels() {
  for (const k in sessions) delete sessions[k];
  await caches.delete(CACHE);
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
export async function downloadModels(onProgress) {
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

export function getSession(name) {
  sessions[name] ??= (async () => {
    const [ort, cache] = await Promise.all([getOrt(), caches.open(CACHE)]);
    const res = await cache.match(MODELS[name].url);
    if (!res) throw new Error('Models not downloaded');
    const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
    return session;
  })();
  sessions[name].catch(() => { delete sessions[name]; });
  return sessions[name];
}

// The wasm backend runs one inference at a time; queue runs so models never overlap.
let queue = Promise.resolve();
export function run(session, feeds) {
  const p = queue.then(() => session.run(feeds));
  queue = p.catch(() => {});
  return p;
}
