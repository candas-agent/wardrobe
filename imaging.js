// High-quality downscaling. A single drawImage from a big phone photo to a small size skips pixels,
// which turns fine fabric weaves into false patterns (moiré); halving step by step averages them.

export function shrink(source, w, h) {
  let cur = source;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const half = new OffscreenCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
    const ctx = half.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

// Shrinks so the longest side is at most max (never enlarges).
export function fit(source, max) {
  const s = Math.min(1, max / Math.max(source.width, source.height));
  return s === 1 ? source : shrink(source, source.width * s, source.height * s);
}
