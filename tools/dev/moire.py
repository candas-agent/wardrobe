import subprocess, time, sys, base64
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8776", "-d", "/tmp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(); page.goto("http://localhost:8776/")
        res = page.evaluate("""async () => {
          const bmp = await createImageBitmap(await (await fetch('/twill.png')).blob());
          const W = 1280, H = 960, out = {};
          const stats = c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0, s2 = 0, n = d.length / 4;
            for (let i = 0; i < d.length; i += 4) { s += d[i]; s2 += d[i] * d[i]; } const m = s / n; return Math.sqrt(s2 / n - m * m); };
          // 1. what the app does now: one drawImage, default smoothing
          let c = new OffscreenCanvas(W, H); c.getContext('2d').drawImage(bmp, 0, 0, W, H); out.single = stats(c);
          const blob1 = await c.convertToBlob({ type: 'image/png' });
          // 2. stepwise halving with high quality
          let cur = bmp;
          while (cur.width / 2 >= W) { const n = new OffscreenCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2)); const x = n.getContext('2d');
            x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, n.width, n.height); cur = n; }
          c = new OffscreenCanvas(W, H); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, W, H); out.stepwise = stats(c);
          const blob2 = await c.convertToBlob({ type: 'image/png' });
          const b64 = bl => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(bl); });
          out.img1 = await b64(blob1); out.img2 = await b64(blob2); return out; }""")
        open("/tmp/moire_single.png", "wb").write(base64.b64decode(res["img1"])); open("/tmp/moire_step.png", "wb").write(base64.b64decode(res["img2"]))
        print(f"contrast left in a texture too fine to show at 1280px (should be ~0): single step {res['single']:.1f}, stepwise {res['stepwise']:.1f}")
        b.close()
finally:
    srv.terminate()
