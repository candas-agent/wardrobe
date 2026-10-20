// Tap-to-select: SlimSAM (Segment Anything) turns tapped points into an outline of the item.
// encode() runs the heavy image encoder once per photo; segment() is cheap and runs on every tap.

import { getOrt, getSession, run } from './models.js';

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// Returns an opaque handle used by segment(). source: ImageBitmap or canvas.
export async function encode(source) {
  const [ort, session] = await Promise.all([getOrt(), getSession('samEncoder')]);
  const W = source.width, H = source.height, s = 1024 / Math.max(W, H);
  const nw = Math.round(W * s), nh = Math.round(H * s);
  const ctx = new OffscreenCanvas(nw, nh).getContext('2d');
  ctx.drawImage(source, 0, 0, nw, nh);
  const px = ctx.getImageData(0, 0, nw, nh).data;
  const data = new Float32Array(3 * 1024 * 1024); // padded bottom/right with zeros
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const i = (y * nw + x) * 4, o = y * 1024 + x;
      for (let c = 0; c < 3; c++) data[c * 1024 * 1024 + o] = (px[i + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  const out = await run(session, { pixel_values: new ort.Tensor('float32', data, [1, 3, 1024, 1024]) }); // same priority as type detection, first come first served
  return { W, H, s, nw, nh, emb: out.image_embeddings, pos: out.image_positional_embeddings };
}

// points: [{ x, y, include }] in source pixels. Returns 3 candidate masks sorted small -> large,
// each { canvas (W x H, alpha = mask), bbox, area, score }, plus the index of the best-scoring one.
export async function segment(enc, points) {
  const [ort, session] = await Promise.all([getOrt(), getSession('samDecoder')]);
  const coords = new Float32Array(points.flatMap(p => [p.x * enc.s, p.y * enc.s]));
  const labels = BigInt64Array.from(points.map(p => BigInt(p.include ? 1 : 0)));
  const out = await run(session, {
    input_points: new ort.Tensor('float32', coords, [1, 1, points.length, 2]),
    input_labels: new ort.Tensor('int64', labels, [1, 1, points.length]),
    image_embeddings: enc.emb,
    image_positional_embeddings: enc.pos,
  }, { priority: 2 }); // a tap's outline jumps ahead of queued type detection
  const scores = out.iou_scores.data, masks = out.pred_masks.data;
  const n = 256 * 256;
  const cands = [0, 1, 2].map(k => ({ ...toMask(enc, masks.subarray(k * n, (k + 1) * n)), score: scores[k] }));
  const best = cands.reduce((b, c, i) => c.score > cands[b].score ? i : b, 0);
  const order = [0, 1, 2].sort((a, b) => cands[a].area - cands[b].area);
  return { masks: order.map(i => cands[i]), best: order.indexOf(best) };
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
