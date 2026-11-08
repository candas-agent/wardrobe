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

// points: [{ x, y, include }] in source pixels -> the decoder's scores and 256x256 low-res logits
async function decode(enc, points) {
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
  return { scores, low: [...Array(count).keys()].map(k => masks.subarray(k * n, (k + 1) * n)) };
}

// points: [{ x, y, include }] in source pixels. Returns the distinct candidate masks (up to 4) sorted
// small -> large, each { canvas (W x H, alpha = mask), bbox, area, score }, plus the index of the best-scoring one.
export async function segment(enc, points) {
  const { scores, low } = await decode(enc, points);
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
  const cands = keep.map(k => ({ ...toMask(enc, lenient(low[k])), score: scores[k] }));
  const order = [...cands.keys()].sort((a, b) => cands[a].area - cands[b].area);
  return { masks: order.map(i => cands[i]), best: order.indexOf(0) }; // keep[0] is the suggestion
}

// The whole person in the user's photo, prompted with body points (and the user's corrections). One mask:
// the decoder's single answer for several points. Specks and the faint haze around the person are dropped
// (only the shape connected to an included point is kept) and the edge is made sharper than for items.
export async function personMask(enc, points) {
  const { low } = await decode(enc, points);
  const logits = Float32Array.from(low[0]);
  const on = new Uint8Array(256 * 256), stack = [];
  const gw = Math.ceil(enc.nw / 4), gh = Math.ceil(enc.nh / 4);
  for (const p of points.filter(p => p.include)) {
    const x = Math.min(gw - 1, Math.floor(p.x * enc.s / 4)), y = Math.min(gh - 1, Math.floor(p.y * enc.s / 4));
    stack.push(y * 256 + x);
  }
  while (stack.length) {
    const i = stack.pop();
    if (on[i] || logits[i] <= 0) continue;
    on[i] = 1;
    const x = i % 256;
    if (x > 0) stack.push(i - 1);
    if (x < 255) stack.push(i + 1);
    if (i >= 256) stack.push(i - 256);
    if (i < 256 * 255) stack.push(i + 256);
  }
  for (let i = 0; i < logits.length; i++) { // keep the person and a one-cell band around it, for a smooth edge
    const x = i % 256;
    const near = on[i] || (x > 0 && on[i - 1]) || (x < 255 && on[i + 1]) || on[i - 256] || on[i + 256];
    logits[i] = near ? logits[i] * 2 : -10;
  }
  return toMask(enc, logits);
}

// Where the model hesitates (logit a little below 0) the app used to show the item half transparent:
// washed-out sleeves, a faded collar or label. Such doubtful cells are now kept when they touch the
// confident part of the outline; doubtful islands elsewhere are dropped. Measured on 37 photos of
// clothes cut out by hand: overlap 90.8 % -> 93.7 % with the hand-made outline (with refine() below),
// 31 photos better, 4 slightly worse (at most -1.7 points).
const DOUBT = 1.5; // logits above -DOUBT count as doubtful

function lenient(logits) {
  const kept = new Uint8Array(256 * 256), stack = [];
  for (let i = 0; i < logits.length; i++) if (logits[i] > 0) stack.push(i);
  while (stack.length) {
    const i = stack.pop();
    if (kept[i] || logits[i] <= -DOUBT) continue;
    kept[i] = 1;
    const x = i % 256;
    if (x > 0) stack.push(i - 1);
    if (x < 255) stack.push(i + 1);
    if (i >= 256) stack.push(i - 256);
    if (i < 256 * 255) stack.push(i + 256);
  }
  return logits.map((v, i) => (kept[i] ? v + DOUBT : Math.min(v + DOUBT, -1)));
}

// The model's outline comes on a 256x256 grid (about 5 photo pixels per cell), scaled up: blocky,
// blurry edges that cut into the item or keep a rim of background. refine() redraws the edge along
// the photo's own colour edges (guided filter, He et al. 2010), only within a few pixels of the
// model's outline, so a garment the colour of the background can't get holes. Edge accuracy
// (outline within 3 px of the hand-made one): 39 % -> 62 % on the same 37 photos.
// Returns a new mask { canvas, bbox, area } with a crisp edge; source is the photo the mask belongs to.
export function refine(source, mask) {
  if (!mask.bbox) return mask;
  const W = source.width, H = source.height;
  const k = Math.max(W, H) / 1280; // tuned at 1280 px
  const R = Math.max(2, Math.round(16 * k)), BAND = Math.max(2, Math.round(8 * k)), EPS = 1e-3;
  // work only on the item's box plus a margin
  const m = R + BAND + 2;
  const x0 = Math.max(0, Math.floor(mask.bbox.x) - m), y0 = Math.max(0, Math.floor(mask.bbox.y) - m);
  const w = Math.min(W, Math.ceil(mask.bbox.x + mask.bbox.w) + m) - x0, h = Math.min(H, Math.ceil(mask.bbox.y + mask.bbox.h) + m) - y0;
  const n = w * h;
  const px = readPixels(source, x0, y0, w, h);
  const alpha = mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
  const p = new Float32Array(n), I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    p[i] = alpha[i * 4 + 3] >= 128 ? 1 : 0;
    for (let c = 0; c < 3; c++) I[c][i] = px[i * 4 + c] / 255;
  }
  const q = guidedFilter(I, p, w, h, R, EPS);
  const near = boxMean(p, w, h, BAND); // strictly between 0 and 1 near the outline
  const out = new OffscreenCanvas(W, H);
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  for (let i = 0; i < n; i++) {
    const v = near[i] > 1e-4 && near[i] < 1 - 1e-4 ? Math.min(1, Math.max(0, (q[i] - 0.5) * 4 + 0.5)) : p[i];
    img.data[i * 4 + 3] = Math.round(v * 255);
  }
  octx.putImageData(img, x0, y0);
  return { ...mask, canvas: out };
}

function readPixels(source, x, y, w, h) {
  if (source.getContext) return source.getContext('2d').getImageData(x, y, w, h).data;
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(source, x, y, w, h, 0, 0, w, h);
  return c.getContext('2d').getImageData(0, 0, w, h).data;
}

// Mean over a (2r+1)^2 window, clipped at the borders (divides by the pixels actually inside).
function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { // horizontal running sum
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
      tmp[row + x] = s / (hi - lo + 1);
      if (x + r + 1 < w) s += src[row + x + r + 1];
      if (x - r >= 0) s -= src[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) { // vertical
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
      out[y * w + x] = s / (hi - lo + 1);
      if (y + r + 1 < h) s += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) s -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

// Colour guided filter: p smoothed so that its edges follow the edges of the colour image I.
// Fast version (He & Sun 2015): the filter's coefficients are computed on a half-size copy and
// scaled back up, about 4x faster with the same result.
function guidedFilter(I, p, w, h, r, eps) {
  const S = 2, sw = Math.ceil(w / S), sh = Math.ceil(h / S), n = sw * sh, rs = Math.max(1, Math.round(r / S));
  const half = src => { // average of each S x S block
    const o = new Float32Array(n), cnt = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = ((y / S) | 0) * sw + ((x / S) | 0); o[k] += src[y * w + x]; cnt[k]++; }
    for (let k = 0; k < n; k++) o[k] /= cnt[k];
    return o;
  };
  const Is = I.map(half), ps = half(p), mean = a => boxMean(a, sw, sh, rs);
  const prod = (a, b) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * b[i]; return o; };
  const mI = Is.map(mean), mp = mean(ps);
  const mIp = Is.map(c => mean(prod(c, ps)));
  const v = {};
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) v[`${i}${j}`] = mean(prod(Is[i], Is[j]));
  const a = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], b = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const r0 = mI[0][k], g0 = mI[1][k], b0 = mI[2][k], pm = mp[k];
    // covariance of I (3x3, symmetric) + eps, and covariance of I with p
    const s00 = v['00'][k] - r0 * r0 + eps, s01 = v['01'][k] - r0 * g0, s02 = v['02'][k] - r0 * b0;
    const s11 = v['11'][k] - g0 * g0 + eps, s12 = v['12'][k] - g0 * b0, s22 = v['22'][k] - b0 * b0 + eps;
    const c0 = mIp[0][k] - r0 * pm, c1 = mIp[1][k] - g0 * pm, c2 = mIp[2][k] - b0 * pm;
    // solve S a = c (inverse via cofactors)
    const i00 = s11 * s22 - s12 * s12, i01 = s02 * s12 - s01 * s22, i02 = s01 * s12 - s02 * s11;
    const i11 = s00 * s22 - s02 * s02, i12 = s01 * s02 - s00 * s12, i22 = s00 * s11 - s01 * s01;
    const det = s00 * i00 + s01 * i01 + s02 * i02;
    const a0 = (i00 * c0 + i01 * c1 + i02 * c2) / det, a1 = (i01 * c0 + i11 * c1 + i12 * c2) / det, a2 = (i02 * c0 + i12 * c1 + i22 * c2) / det;
    a[0][k] = a0; a[1][k] = a1; a[2][k] = a2;
    b[k] = pm - a0 * r0 - a1 * g0 - a2 * b0;
  }
  const ma = a.map(mean), mb = mean(b), q = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { // bilinear upsampling of the coefficients, applied to the full-size image
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / S - 0.5)), y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / S - 0.5)), x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const k00 = y0 * sw + x0, k01 = y0 * sw + x1, k10 = y1 * sw + x0, k11 = y1 * sw + x1;
      const lerp = c => (c[k00] * (1 - tx) + c[k01] * tx) * (1 - ty) + (c[k10] * (1 - tx) + c[k11] * tx) * ty;
      const i = y * w + x;
      q[i] = lerp(mb) + lerp(ma[0]) * I[0][i] + lerp(ma[1]) * I[1][i] + lerp(ma[2]) * I[2][i];
    }
  }
  return q;
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

// The source with everything outside the mask transparent, same size (so body points still line up).
export function cutoutFull(source, mask) {
  const c = new OffscreenCanvas(source.width, source.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask.canvas, 0, 0);
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
