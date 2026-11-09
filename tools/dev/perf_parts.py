import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        ctx = b.new_context(); page = ctx.new_page()
        page.set_default_timeout(600000); page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        page.reload(); page.wait_for_selector("h1, .topbar")
        print("isolated:", page.evaluate("crossOriginIsolated"), "| cores:", page.evaluate("navigator.hardwareConcurrency"), "| threads:", page.evaluate("import('./models.js').then(m => m.THREADS)"))
        ctx.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": int(sys.argv[1]) if len(sys.argv) > 1 else 4})
        print(page.evaluate("""async () => {
          const m = await import('./models.js'), seg = await import('./segment.js'), cls = await import('./classify.js');
          const out = {}; let t = performance.now(); const lap = k => { const n = performance.now(); out[k] = ((n - t) / 1000).toFixed(2) + 's'; t = n; };
          await m.getOrt(); lap('load onnxruntime');
          await m.getSession('samDecoder'); lap('create decoder session');
          await m.getSession('samEncoder'); lap('create encoder session');
          await m.getSession('clip'); lap('create CLIP session');
          const bmp = await createImageBitmap(await (await fetch('/icons/icon-512.png')).blob());
          const c = new OffscreenCanvas(1200, 900); c.getContext('2d').drawImage(bmp, 0, 0, 1200, 900);
          const enc = await seg.encode(c); lap('encode photo');
          await seg.segment(enc, [{ x: 600, y: 450, include: true }]); lap('decode tap (1st)');
          await seg.segment(enc, [{ x: 300, y: 450, include: true }]); lap('decode tap (2nd)');
          await cls.classifyType(c); lap('CLIP type (1st)');
          await cls.classifyType(c); lap('CLIP type (2nd)');
          cls.dominantColours(c); lap('colour');
          return out; }"""))
        b.close()
finally:
    srv.terminate()
