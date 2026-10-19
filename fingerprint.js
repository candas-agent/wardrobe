// Photo fingerprints for duplicate warnings.
// sha256: exact same file. tiny: the picture shrunk to 16x16 colour pixels, which survives
// resizing/recompression (phones often re-encode gallery photos, so the bytes differ).
// Compared by RMS pixel difference. A difference-hash was tried first, but on plain backgrounds
// unrelated photos collided far too often (2% of pairs); this gave ~0.01% on the same test set.

export async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// source: ImageBitmap or canvas. Returns 16x16 RGB as base64 (1 KB).
export function tiny(source) {
  // shrink in steps so each pixel averages its area instead of sampling stray pixels
  let cur = source;
  while (Math.max(cur.width, cur.height) > 64) {
    const c = new OffscreenCanvas(Math.max(16, Math.round(cur.width / 2)), Math.max(16, Math.round(cur.height / 2)));
    c.getContext('2d').drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
  }
  const ctx = new OffscreenCanvas(16, 16).getContext('2d');
  ctx.drawImage(cur, 0, 0, 16, 16);
  const px = ctx.getImageData(0, 0, 16, 16).data;
  let bin = '';
  for (let i = 0; i < 256; i++) bin += String.fromCharCode(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  return btoa(bin);
}

export function distance(a, b) {
  const x = atob(a), y = atob(b);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += (x.charCodeAt(i) - y.charCodeAt(i)) ** 2;
  return Math.sqrt(sum / x.length);
}

export const SAME_PICTURE = 8; // max RMS difference (0-255) to call two photos the same picture
