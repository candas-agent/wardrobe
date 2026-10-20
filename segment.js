// Tap-to-select: EdgeSAM (a phone-sized Segment Anything) turns a tapped point into outlines of the item.
// encode() runs the heavy image encoder once per photo; segment() is cheap and runs on every tap.
// EdgeSAM-3x was chosen over SlimSAM-77 after measuring: ~3x faster in the browser, same outline quality.

import { getOrt, getSession, run, isEncoderOnGpu, gpuFailed } from './models.js';
import { shrink } from './imaging.js';

const MEAN = [0.485, 0.456, 0.406]; // ImageNet normalisation (EdgeSAM's 123.675/58.395 on 0-255 pixels)
const STD = [0.229, 0.224, 0.225];

// Returns an opaque handle used by segment(). source: ImageBitmap or canvas.
export async function encode(source) {
  const [ort, session] = await Promise.all([getOrt(), getSession('samEncoder')]);
  const W = source.width, H = source.height, s = 1024 / Math.max(W, H);
  const nw = Math.round(W * s), nh = Math.round(H * s);
  const px = shrink(source, nw, nh).getContext('2d').getImageData(0, 0, nw, nh).data;
  const data = new Float32Array(3 * 1024 * 1024); // padded bottom/right with zeros
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const i = (y * nw + x) * 4, o = y * 1024 + x;
      for (let c = 0; c < 3; c++) data[c * 1024 * 1024 + o] = (px[i + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  const feeds = { image: new ort.Tensor('float32', data, [1, 3, 1024, 1024]) };
  let out;
  try {
    out = await run(session, feeds); // same priority as type detection, first come first served
  } catch (err) {
    if (!isEncoderOnGpu()) throw err;
    gpuFailed(err); // didn't work on this graphics chip: redo it on the processor
    out = await run(await getSession('samEncoder'), feeds);
  }
  return { W, H, s, nw, nh, emb: out.image_embeddings };
}

// points: [{ x, y, include }] in source pixels. Returns the distinct candidate masks (up to 4) sorted
// small -> large, each { canvas (W x H, alpha = mask), bbox, area, score }, plus the index of the best-scoring one.
export async function segment(enc, points) {
  const [ort, session] = await Promise.all([getOrt(), getSession('samDecoder')]);
  const coords = new Float32Array(points.flatMap(p => [p.x * enc.s, p.y * enc.s]));
  const labels = Float32Array.from(points.map(p => (p.include ? 1 : 0)));
  const out = await run(session, {
    image_embeddings: enc.emb,
    point_coords: new ort.Tensor('float32', coords, [1, points.length, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, points.length]),
  }, { priority: 2 }); // a tap's outline jumps ahead of queued type detection
  const scores = out.scores.data, masks = out.masks.data, count = out.masks.dims[1];
  const n = 256 * 256;
  const low = [...Array(count).keys()].map(k => masks.subarray(k * n, (k + 1) * n));
  // With one point the outline is ambiguous (pocket, jacket, whole person?): suggest the best score.
  // With several points output 0 is the model's single answer meant for clear prompts; the others
  // tend to grab neighbours (e.g. the trousers under an open jacket).
  const rank = [...low.keys()].sort((a, b) => scores[b] - scores[a]);
  if (points.length > 1) rank.unshift(...rank.splice(rank.indexOf(0), 1));
  // drop near-duplicates (the model often returns two practically identical outlines), keep the better ranked
  const keep = [];
  for (const k of rank) {
    if (!keep.some(j => overlap(low[j], low[k]) > 0.95)) keep.push(k);
  }
  const cands = keep.map(k => ({ ...toMask(enc, low[k]), score: scores[k] }));
  const order = [...cands.keys()].sort((a, b) => cands[a].area - cands[b].area);
  return { masks: order.map(i => cands[i]), best: order.indexOf(0) }; // keep[0] is the suggestion
}

// intersection over union of two low-res masks (logit > 0)
function overlap(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] > 0, y = b[i] > 0; inter += x && y; union += x || y; }
  return union ? inter / union : 1;
}

// Low-res 256x256 logits -> soft alpha mask at source size. The 256 grid covers the padded
// 1024 square, so only the top-left nw/4 x nh/4 part maps onto the photo.
function toMask(enc, logits) {
  const low = new OffscreenCanvas(256, 256);
  const lctx = low.getContext('2d');
  const img = lctx.createImageData(256, 256);
  let x0 = 256, y0 = 256, x1 = -1, y1 = -1, count = 0;
  for (let i = 0; i < 256 * 256; i++) {
    const v = logits[i];
    img.data[i * 4 + 3] = Math.max(0, Math.min(255, 128 + v * 64)); // soft edge around logit 0
    if (v > 0) {
      const x = i % 256, y = (i / 256) | 0;
      count++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  lctx.putImageData(img, 0, 0);
  const canvas = new OffscreenCanvas(enc.W, enc.H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(low, 0, 0, enc.nw / 4, enc.nh / 4, 0, 0, enc.W, enc.H);
  const k = 4 / enc.s; // low-res cell -> source pixels
  const bbox = x1 < 0 ? null : {
    x: Math.max(0, x0 * k), y: Math.max(0, y0 * k),
    w: Math.min(enc.W, (x1 + 1) * k) - Math.max(0, x0 * k), h: Math.min(enc.H, (y1 + 1) * k) - Math.max(0, y0 * k),
  };
  return { canvas, bbox, area: count / ((enc.nw / 4) * (enc.nh / 4)) };
}

// Transparent cut-out of the masked item, cropped to it with a small margin.
export function cutout(source, mask) {
  const { bbox } = mask;
  const pad = Math.round(0.04 * Math.max(bbox.w, bbox.h));
  const x = Math.max(0, Math.floor(bbox.x - pad)), y = Math.max(0, Math.floor(bbox.y - pad));
  const w = Math.min(source.width - x, Math.ceil(bbox.w + 2 * pad)), h = Math.min(source.height - y, Math.ceil(bbox.h + 2 * pad));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask.canvas, x, y, w, h, 0, 0, w, h);
  return c;
}

// Cut-out flattened onto white (for storage as JPEG).
export function onWhite(canvas) {
  const c = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  return c;
}
