import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8769", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"]); page = b.new_page(); page.set_default_timeout(600000)
        logs = []; page.on("console", lambda m: logs.append(m.text) if "accuracy" in m.text else None)
        page.goto("http://localhost:8769/"); page.wait_for_timeout(1500)
        print(page.evaluate("""async () => {
          const m = await import('./models.js'); const ort = await m.getOrt();
          const SAM = 'https://huggingface.co/chongzhou/EdgeSAM/resolve/e0564124628944e1622973d4e0f68158b46f035a/';
          const mk = async (f, o = {}) => ort.InferenceSession.create(new Uint8Array(await (await fetch(SAM + f)).arrayBuffer()), { executionProviders: ['wasm'], ...o });
          const out = {};
          const attempt = async (label, s) => { try { out[label] = (await m.checkGpu(ort, s)).toFixed(4); } catch (e) { out[label] = 'ERROR: ' + e.message; } };
          const full = await mk('edge_sam_3x_encoder.onnx');
          await attempt('EdgeSAM cpu (like a working GPU)', full);
          await attempt('EdgeSAM basic', await mk('edge_sam_3x_encoder.onnx', { graphOptimizationLevel: 'basic' }));
          await attempt('EdgeSAM disabled', await mk('edge_sam_3x_encoder.onnx', { graphOptimizationLevel: 'disabled' }));
          // a "broken GPU": correct shape, slightly wrong numbers
          const broken = { run: async f => { const r = await full.run(f); const d = r.image_embeddings.data;
            for (let i = 0; i < d.length; i++) d[i] = d[i] * 0.85 + 0.05 * Math.sin(i); return r; } };
          await attempt('broken (15% off)', broken);
          return out; }"""))
        print("\n".join(logs))
        b.close()
finally:
    srv.terminate()
