// On-device tagging: clothing type via CLIP (onnxruntime-web) and dominant colour via k-means.
// Type: the photo's CLIP image embedding is compared with precomputed text embeddings (labels.json).

import { PALETTE, loadTypes } from './catalog.js';
import { getOrt, getSession, run } from './models.js';

const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

// CLIP preprocessing: resize shortest edge to 224, centre crop, normalise, CHW float32.
function pixelValues(source) {
  const w = source.width, h = source.height, s = 224 / Math.min(w, h);
  const c = new OffscreenCanvas(224, 224);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // cut-outs are transparent: show them like a product photo
  ctx.fillRect(0, 0, 224, 224);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, (224 - w * s) / 2, (224 - h * s) / 2, w * s, h * s);
  const px = ctx.getImageData(0, 0, 224, 224).data;
  const out = new Float32Array(3 * 224 * 224);
  for (let i = 0; i < 224 * 224; i++) {
    for (let ch = 0; ch < 3; ch++) out[ch * 224 * 224 + i] = (px[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
  }
  return out;
}

// Returns types sorted by probability: [{ id, label, group, p }, ...]
// stale(): returns true once the result isn't wanted any more (the job is then skipped if still queued).
export async function classifyType(source, { stale } = {}) {
  const [ort, session, types] = await Promise.all([getOrt(), getSession('clip'), loadTypes()]);
  const input = new ort.Tensor('float32', pixelValues(source), [1, 3, 224, 224]);
  const { image_embeds } = await run(session, { pixel_values: input }, { stale });
  const v = image_embeds.data;
  const norm = Math.hypot(...v);
  const logits = types.map(t => 100 * t.emb.reduce((s, e, i) => s + e * v[i], 0) / norm);
  const max = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return types
    .map((t, i) => ({ id: t.id, label: t.label, group: t.group, p: exps[i] / sum }))
    .sort((a, b) => b.p - a.p);
}

// ---- colour ----

function srgbToLab(r, g, b) {
  const lin = c => (c /= 255) > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  const R = lin(r), G = lin(g), B = lin(b);
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const PALETTE_LAB = PALETTE.map(c => srgbToLab(...[1, 3, 5].map(i => parseInt(c.hex.slice(i, i + 2), 16))));
const L_WEIGHT = 0.75; // lighting varies, so lightness counts less than hue when naming

function nearestColour(lab) {
  let best = 0, bestD = Infinity;
  PALETTE_LAB.forEach((p, i) => {
    const d = (L_WEIGHT * (p[0] - lab[0])) ** 2 + (p[1] - lab[1]) ** 2 + (p[2] - lab[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return PALETTE[best].id;
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// Returns up to two palette ids, most dominant first. If the source is a transparent cut-out its
// alpha is the mask; otherwise the background is estimated as the median of the border pixels.
export function dominantColours(source) {
  const s = 64 / Math.max(source.width, source.height);
  const w = Math.max(1, Math.round(source.width * s)), h = Math.max(1, Math.round(source.height * s));
  const ctx = new OffscreenCanvas(w, h).getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  const lab = [], weight = [], border = [], opaque = [];
  let cutout = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = srgbToLab(px[i], px[i + 1], px[i + 2]);
      opaque.push(px[i + 3] > 200);
      if (px[i + 3] < 255) cutout = true;
      lab.push(l);
      // centre-weighted: the garment is usually in the middle of the frame
      weight.push(Math.exp(-(((x - w / 2) / (w * 0.35)) ** 2 + ((y - h / 2) / (h * 0.35)) ** 2) / 2));
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) border.push(l);
    }
  }
  const median = k => { const v = border.map(b => b[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = [median(0), median(1), median(2)];

  let X = [], W = [];
  if (cutout) {
    lab.forEach((l, i) => { if (opaque[i]) { X.push(l); W.push(1); } });
  } else {
    lab.forEach((l, i) => { if (dist2(l, bg) > 15 * 15) { X.push(l); W.push(weight[i]); } });
  }
  const fgMass = W.reduce((a, b) => a + b, 0), allMass = weight.reduce((a, b) => a + b, 0);
  if (!cutout && fgMass < 0.1 * allMass || !X.length) { X = lab; W = weight; } // garment same colour as the background

  // weighted k-means, k=3, deterministic init at lightness quantiles
  const sorted = X.map((l, i) => i).sort((a, b) => X[a][0] - X[b][0]);
  const C = [0.15, 0.5, 0.85].map(q => [...X[sorted[Math.floor(q * (X.length - 1))]]]);
  const lbl = new Array(X.length);
  for (let it = 0; it < 10; it++) {
    X.forEach((x, i) => {
      let b = 0;
      for (let k = 1; k < 3; k++) if (dist2(x, C[k]) < dist2(x, C[b])) b = k;
      lbl[i] = b;
    });
    for (let k = 0; k < 3; k++) {
      const acc = [0, 0, 0]; let m = 0;
      X.forEach((x, i) => { if (lbl[i] === k) { acc[0] += x[0] * W[i]; acc[1] += x[1] * W[i]; acc[2] += x[2] * W[i]; m += W[i]; } });
      if (m) C[k] = acc.map(a => a / m);
    }
  }
  const mass = [0, 0, 0];
  X.forEach((x, i) => { mass[lbl[i]] += W[i]; });
  const total = mass[0] + mass[1] + mass[2];
  const names = [0, 1, 2].sort((a, b) => mass[b] - mass[a])
    .filter((k, rank) => rank === 0 || mass[k] > 0.15 * total)
    .map(k => nearestColour(C[k]));
  return [...new Set(names)].slice(0, 2);
}
