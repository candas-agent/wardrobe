import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        ctx = b.new_context(); page = ctx.new_page(); page.set_default_timeout(600000)
        page.goto("http://localhost:8765/"); page.wait_for_timeout(1000)
        print(page.evaluate("""async () => {
          const m = await import('./models.js'); const ort = await m.getOrt();
          const SAM = 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/';
          const CLIP = 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/';
          const out = {};
          const bench = async (label, url, feeds) => {
            const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
            let t = performance.now(); const s = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
            const create = performance.now() - t;
            t = performance.now(); const r = await s.run(feeds()); const run1 = performance.now() - t;
            t = performance.now(); await s.run(feeds()); const run2 = performance.now() - t;
            out[label] = `${(buf.length/1e6).toFixed(0)}MB create ${(create/1000).toFixed(2)}s run ${(run1/1000).toFixed(2)}s / ${(run2/1000).toFixed(2)}s`;
            return r;
          };
          const px = () => ({ pixel_values: new ort.Tensor('float32', new Float32Array(3*1024*1024).fill(0.1), [1,3,1024,1024]) });
          const e8 = await bench('encoder int8', SAM + 'vision_encoder_quantized.onnx', px);
          const e32 = await bench('encoder fp32', SAM + 'vision_encoder.onnx', px);
          const dec = () => ({ input_points: new ort.Tensor('float32', new Float32Array([500, 400]), [1,1,1,2]),
            input_labels: new ort.Tensor('int64', BigInt64Array.from([1n]), [1,1,1]),
            image_embeddings: e32.image_embeddings, image_positional_embeddings: e32.image_positional_embeddings });
          await bench('decoder int8', SAM + 'prompt_encoder_mask_decoder_quantized.onnx', dec);
          await bench('decoder fp32', SAM + 'prompt_encoder_mask_decoder.onnx', dec);
          const cp = () => ({ pixel_values: new ort.Tensor('float32', new Float32Array(3*224*224).fill(0.1), [1,3,224,224]) });
          await bench('clip int8', CLIP + 'vision_model_quantized.onnx', cp);
          await bench('clip fp16', CLIP + 'vision_model_fp16.onnx', cp);
          return out; }"""))
        b.close()
finally:
    srv.terminate()
