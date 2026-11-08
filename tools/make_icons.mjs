// App icons -> icons/*.png (and icons/icon.svg, the master drawing).
// Renders the SVG below with the pre-installed Chromium (Playwright).
//
//     node tools/make_icons.mjs
//
// The mascot: a hanger whose hook is the head (winking face inside), the arms are the shoulders,
// with a polka-dot bow tie at the neck. Drawn on a 512 grid; "any" icons fill the square, the
// maskable one shrinks the artwork into the 80 % safe circle Android launchers keep after cropping.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dir = fileURLToPath(new URL('../icons/', import.meta.url));

const BG = '#f6f3ee', ACCENT = '#b5562f', BLUE = '#3f6e8c', INK = '#2a1a12', BLUSH = '#e8846a';

// Hook = open circle (centre 256,cy, radius r) with the gap at the lower left; the stem goes down to the neck.
function hook(cy, r, neck) {
  const a = 150 * Math.PI / 180;
  const x = (256 + r * Math.cos(a)).toFixed(1), y = (cy + r * Math.sin(a)).toFixed(1);
  return `M256 ${neck}V${cy + r}A${r} ${r} 0 1 0 ${x} ${y}`;
}
const wings = 'M0 0 L-40 -22 Q-48 0 -40 22 Z M0 0 L40 -22 Q48 0 40 22 Z';

// scale: size of the artwork relative to the canvas, centred on (256, 256)
function svg(scale = 1) {
  // artwork spans y 78..360 on its own grid -> centre it
  const t = `translate(256 256) scale(${scale}) translate(-256 -219)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
      <rect width="20" height="20" fill="${BLUE}"/><circle cx="10" cy="10" r="3.5" fill="#f8efe4"/>
    </pattern>
  </defs>
  <rect width="512" height="512" fill="${BG}"/>
  <g transform="${t}">
    <path d="${hook(148, 64, 236)}" fill="none" stroke="${ACCENT}" stroke-width="20" stroke-linecap="round"/>
    <!-- face: open eye, winking eye, cheeks, smile -->
    <circle cx="234" cy="142" r="11" fill="${INK}"/><circle cx="237.9" cy="138.2" r="3.6" fill="#fff"/>
    <path d="M268 142 Q 278 134 288 142" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
    <ellipse cx="220" cy="166" rx="10" ry="6" fill="${BLUSH}" opacity=".7"/>
    <ellipse cx="292" cy="166" rx="10" ry="6" fill="${BLUSH}" opacity=".7"/>
    <path d="M240 162 Q 256 180 272 162" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
    <!-- shoulders -->
    <path d="M256 236L84 348H428Z" fill="none" stroke="${ACCENT}" stroke-width="22" stroke-linejoin="round"/>
    <!-- bow tie -->
    <g transform="translate(256 240)">
      <path d="${wings}" fill="url(#dots)"/>
      <path d="${wings}" fill="#000" opacity=".12" transform="scale(1 .45) translate(0 26)"/>
      <rect x="-11" y="-12" width="22" height="24" rx="6" fill="${BLUE}"/>
      <rect x="-11" y="-12" width="22" height="24" rx="6" fill="#000" opacity=".15"/>
    </g>
  </g>
</svg>`;
}

const out = [
  ['icon-512.png', 512, 0.92],
  ['icon-192.png', 192, 0.92],
  ['apple-touch-icon.png', 180, 0.92],
  ['icon-maskable-512.png', 512, 0.8],
];

writeFileSync(dir + 'icon.svg', svg(0.92));
const browser = await chromium.launch();
for (const [name, size, scale] of out) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg(scale)}`);
  await page.screenshot({ path: dir + name });
  await page.close();
  console.log(name, size);
}
await browser.close();
