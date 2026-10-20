// "On me": a paper doll. MoveNet finds the body (shoulders, hips, ankles...) on the user's photo once;
// item cut-outs are then placed on it by type, and the user can drag/pinch each item to adjust.
// Placements and adjustments are in body units (shoulder width), so they carry over to a new photo.

import { getOrt, poseSession, run } from './models.js';
import { fit } from './imaging.js';

// MoveNet keypoints (COCO order)
const K = { nose: 0, lEar: 3, rEar: 4, lShoulder: 5, rShoulder: 6, lWrist: 9, rWrist: 10, lHip: 11, rHip: 12, lAnkle: 15, rAnkle: 16 };
const MIN_SCORE = 0.2;

async function keypoints(source, crop, onProgress) {
  const [ort, session] = await Promise.all([getOrt(), poseSession(onProgress)]);
  const N = 256, S = Math.max(crop.w, crop.h);
  const c = new OffscreenCanvas(N, N), ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w / S * N, crop.h / S * N); // letterboxed, top-left
  const px = ctx.getImageData(0, 0, N, N).data, data = new Int32Array(N * N * 3);
  for (let i = 0; i < N * N; i++) for (let k = 0; k < 3; k++) data[i * 3 + k] = px[i * 4 + k];
  const out = (await run(session, { input: new ort.Tensor('int32', data, [1, N, N, 3]) })).output_0.data;
  return [...Array(17).keys()].map(i => ({ x: crop.x + out[i * 3 + 1] * S, y: crop.y + out[i * 3] * S, score: out[i * 3 + 2] }));
}

// source: ImageBitmap/canvas. Returns { W, H, kpts, ok }. Two passes: the whole photo, then a crop
// around the person found (MoveNet works best when the person fills its 256x256 input).
export async function detectPose(source, onProgress) {
  const W = source.width, H = source.height;
  let kpts = await keypoints(source, { x: 0, y: 0, w: W, h: H }, onProgress);
  const seen = kpts.filter(p => p.score > MIN_SCORE);
  if (seen.length >= 6) {
    const xs = seen.map(p => p.x), ys = seen.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const m = 0.2 * Math.max(x1 - x0, y1 - y0);
    const crop = { x: Math.max(0, x0 - m), y: Math.max(0, y0 - m) };
    crop.w = Math.min(W, x1 + m) - crop.x; crop.h = Math.min(H, y1 + m) - crop.y;
    kpts = await keypoints(source, crop);
  }
  const ok = [K.lShoulder, K.rShoulder, K.lHip, K.rHip, K.lAnkle, K.rAnkle].every(i => kpts[i].score > MIN_SCORE);
  return { W, H, kpts, ok };
}

// Body measurements in photo pixels. Without a usable pose, a standing figure filling the photo is assumed.
function body(pose) {
  const p = pose.kpts, { W, H } = pose;
  if (!pose.ok) {
    const sw = Math.min(W * 0.32, H * 0.13), cx = W / 2;
    return { sw, hw: sw * 0.62, neck: { x: cx, y: H * 0.2 }, hip: { x: cx, y: H * 0.5 }, ankleY: H * 0.9,
      ankles: [{ x: cx - sw * 0.25, y: H * 0.9 }, { x: cx + sw * 0.25, y: H * 0.9 }], noseY: H * 0.1, wrist: { x: cx + sw * 0.7, y: H * 0.5 } };
  }
  const mid = (a, b) => ({ x: (p[a].x + p[b].x) / 2, y: (p[a].y + p[b].y) / 2 });
  const dist = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);
  const ankles = [p[K.rAnkle], p[K.lAnkle]].sort((a, b) => a.x - b.x);
  return {
    sw: dist(K.lShoulder, K.rShoulder), hw: dist(K.lHip, K.rHip),
    neck: mid(K.lShoulder, K.rShoulder), hip: mid(K.lHip, K.rHip),
    ankleY: (ankles[0].y + ankles[1].y) / 2, ankles,
    noseY: p[K.nose].score > MIN_SCORE ? p[K.nose].y : mid(K.lShoulder, K.rShoulder).y - dist(K.lShoulder, K.rShoulder) * 0.7,
    wrist: p[K.lWrist].x > p[K.rWrist].x ? p[K.lWrist] : p[K.rWrist], // the one on the right of the photo
  };
}

// ---- item pictures with transparency

// Cut-outs saved since "On me" exist keep their transparency (item.cutout). Older items are stored on
// white: the white connected to the picture's border is made transparent.
export async function itemArt(item) {
  const bmp = await createImageBitmap(item.cutout ?? item.photo);
  const small = fit(bmp, 900), canvas = new OffscreenCanvas(small.width, small.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(small, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (!item.cutout) whiteToClear(img);
  ctx.putImageData(img, 0, 0);
  const box = opaqueBox(img);
  const art = new OffscreenCanvas(box.w, box.h);
  art.getContext('2d').drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const data = art.getContext('2d').getImageData(0, 0, box.w, box.h);
  return { blob: await art.convertToBlob({ type: 'image/png' }), w: box.w, h: box.h, alpha: (x, y) => data.data[(y * box.w + x) * 4 + 3],
    rowWidth: f => rowWidth(data, f), parts: parts(data) };
}

function whiteToClear(img) {
  const { width: w, height: h, data } = img;
  const whitish = i => data[i * 4] > 232 && data[i * 4 + 1] > 232 && data[i * 4 + 2] > 232;
  const seen = new Uint8Array(w * h), stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (seen[i] || !whitish(i)) continue;
    seen[i] = 1;
    data[i * 4 + 3] = 0;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i < w * (h - 1)) stack.push(i + w);
  }
}

function opaqueBox(img) {
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? { x: 0, y: 0, w, h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Number of separate big shapes (a photo of a pair of shoes has two, a single shoe one).
function parts(img) {
  const k = Math.max(1, Math.ceil(Math.max(img.width, img.height) / 120)); // count on a ~120 px grid
  const w = Math.ceil(img.width / k), h = Math.ceil(img.height / k), on = new Uint8Array(w * h);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] > 128) on[Math.floor(y / k) * w + Math.floor(x / k)] = 1;
  }
  const label = new Int32Array(w * h), sizes = [];
  for (let start = 0; start < w * h; start++) {
    if (!on[start] || label[start]) continue;
    let n = 0;
    const stack = [start];
    label[start] = sizes.length + 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w;
      n++;
      for (const j of [x > 0 && i - 1, x < w - 1 && i + 1, i - w, i + w]) {
        if (j !== false && j >= 0 && j < w * h && on[j] && !label[j]) { label[j] = sizes.length + 1; stack.push(j); }
      }
    }
    sizes.push(n);
  }
  const big = Math.max(0, ...sizes);
  return sizes.filter(n => n > big * 0.25).length; // ignore specks and laces
}

// opaque width of the row at fraction f of the height (e.g. a top's shoulder line)
function rowWidth(img, f) {
  const { width: w, height: h, data } = img, y = Math.min(h - 1, Math.floor(f * h));
  let x0 = -1, x1 = -1;
  for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 128) { if (x0 < 0) x0 = x; x1 = x; }
  return x0 < 0 ? w : x1 - x0 + 1;
}

// ---- placement

// Where an item goes on the body, before the user's adjustment: a list of boxes { x, y, w, h, mirror }
// in photo pixels (shoes give two, one per foot). layer: outfit layer key; type: item type id.
function autoPlace(b, art, layer, type) {
  const torso = b.hip.y - b.neck.y;
  const uniform = (w, ax, ay, f) => { // scale to width w, the row at fraction f of the height sits at ay
    const h = w * art.h / art.w;
    return [{ x: ax - w / 2, y: ay - f * h, w, h }];
  };
  const byRow = (rowW, f) => rowW * art.w / art.rowWidth(f); // overall width that gives row f the width rowW
  if (layer === 'shoes') {
    const bottom = b.ankleY + 0.12 * torso;
    if (art.parts >= 2 || art.w > art.h * 2.1) { // a photo of the pair (apart, or touching: very wide): once, across both feet
      const w = Math.abs(b.ankles[1].x - b.ankles[0].x) + b.sw * 0.55, h = w * art.h / art.w;
      return [{ x: (b.ankles[0].x + b.ankles[1].x) / 2 - w / 2, y: bottom - h, w, h }];
    }
    const w = b.sw * 0.5, h = w * art.h / art.w; // a single shoe: on each foot, one of them mirrored
    return b.ankles.map((a, i) => ({ x: a.x - w / 2, y: bottom - h, w, h, mirror: i === 0 }));
  }
  if (layer === 'bottom' && ['trousers', 'jeans', 'leggings'].includes(type)) { // waist at the hips, hem at the ankles
    const top = b.hip.y - 0.12 * torso, w = byRow(b.hw * 1.9, 0.03);
    return [{ x: b.hip.x - w / 2, y: top, w, h: b.ankleY + 0.06 * torso - top }];
  }
  if (layer === 'bottom' && type !== 'dress' && type !== 'jumpsuit' && type !== 'swimwear') { // shorts, skirt
    return uniform(byRow(b.hw * 1.9, 0.03), b.hip.x, b.hip.y - 0.12 * torso, 0);
  }
  if (layer === 'acc') {
    if (type === 'hat') return uniform(b.sw * 0.95, b.neck.x, b.noseY - 0.2 * b.sw, 1);
    if (type === 'scarf') return uniform(b.sw * 0.8, b.neck.x, b.neck.y - 0.15 * b.sw, 0);
    if (type === 'belt') return uniform(b.hw * 2, b.hip.x, b.hip.y - 0.1 * torso, 0.5);
    const h = torso * 0.55, w = h * art.w / art.h; // bag, hanging from the hand
    return [{ x: b.wrist.x - w / 2, y: b.wrist.y - h * 0.15, w, h }];
  }
  // tops, outerwear, dresses: the shoulder line of the garment on the shoulders
  return uniform(byRow(b.sw * (layer === 'outer' ? 1.5 : 1.35), 0.15), b.neck.x, b.neck.y, 0.15);
}

// fit: { dx, dy, s } — the user's adjustment, moves in shoulder widths and a scale factor
export function place(pose, art, layer, type, fit) {
  const b = body(pose), { dx = 0, dy = 0, s = 1 } = fit ?? {};
  return autoPlace(b, art, layer, type).map(r => {
    const cx = r.x + r.w / 2 + dx * b.sw, cy = r.y + r.h / 2 + dy * b.sw, w = r.w * s, h = r.h * s;
    return { x: cx - w / 2, y: cy - h / 2, w, h, mirror: !!r.mirror };
  });
}

export const shoulderWidth = pose => body(pose).sw;
