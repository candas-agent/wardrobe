import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8774", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"]); ctx = b.new_context(); page = ctx.new_page(); page.set_default_timeout(1800000)
        page.goto("http://localhost:8774/"); page.wait_for_function("navigator.serviceWorker.controller"); page.wait_for_timeout(1500); page.reload(); page.wait_for_selector(".topbar")
        print("isolated:", page.evaluate("crossOriginIsolated"))
        JS = """async () => {
          const m = await import('./models.js'); const ort = await m.getOrt();
          const HF = 'https://huggingface.co/';
          const T = (d, dims) => new ort.Tensor('float32', d, dims);
          const C = [
            ['SlimSAM int8 (current)', HF + 'Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/vision_encoder_quantized.onnx', () => ({ pixel_values: T(new Float32Array(3*1024*1024).fill(.1), [1,3,1024,1024]) })],
            ['EdgeSAM-3x', HF + 'chongzhou/EdgeSAM/resolve/main/edge_sam_3x_encoder.onnx', () => ({ image: T(new Float32Array(3*1024*1024).fill(.1), [1,3,1024,1024]) })],
            ['MobileSAM', HF + 'PulpCut/mobilesam-onnx/resolve/main/mobilesam.encoder.onnx', () => ({ input_image: T(new Float32Array(768*1024*3).fill(120), [768,1024,3]) })],
          ];
          const out = {};
          for (const [label, url, feeds] of C) {
            const s = await ort.InferenceSession.create(new Uint8Array(await (await fetch(url)).arrayBuffer()), { executionProviders: ['wasm'] });
            await s.run(feeds()); let t = performance.now(); await s.run(feeds()); await s.run(feeds());
            out[label] = ((performance.now() - t) / 2000).toFixed(2) + 's';
          }
          return out; }"""
        print("full speed:", page.evaluate(JS))
        ctx.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": 4})
        print("phone-like (4x slower CPU):", page.evaluate(JS))
        b.close()
finally:
    srv.terminate()
