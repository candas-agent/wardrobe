import subprocess, time, sys, base64
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8771", "-d", "/tmp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
img = base64.b64encode(open("/tmp/flatlay.jpg", "rb").read()).decode()
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader"])
        page = b.new_page(); page.set_default_timeout(900000); logs = []
        page.on("console", lambda m: print(f"[{m.type}] {m.text}", flush=True))
        page.goto("http://localhost:8771/")
        print(page.evaluate("""async (img) => {
          const CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
          const ort = await import(CDN + 'ort.webgpu.min.mjs'); ort.env.wasm.wasmPaths = CDN; ort.env.wasm.numThreads = 1;
          const SAM = 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/';
          const buf = async f => new Uint8Array(await (await fetch(SAM + f)).arrayBuffer());
          // the real photo, preprocessed like segment.js
          const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + img)).blob());
          const s = 1024 / Math.max(bmp.width, bmp.height), nw = Math.round(bmp.width * s), nh = Math.round(bmp.height * s);
          const ctx = new OffscreenCanvas(nw, nh).getContext('2d'); ctx.drawImage(bmp, 0, 0, nw, nh);
          const px = ctx.getImageData(0, 0, nw, nh).data, data = new Float32Array(3 * 1024 * 1024);
          const M = [0.485, 0.456, 0.406], S = [0.229, 0.224, 0.225];
          for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 3; c++) data[c*1048576 + y*1024 + x] = (px[(y*nw+x)*4+c]/255 - M[c]) / S[c];
          const feeds = () => ({ pixel_values: new ort.Tensor('float32', data, [1, 3, 1024, 1024]) });
          const dec = await ort.InferenceSession.create(await buf('prompt_encoder_mask_decoder_quantized.onnx'), { executionProviders: ['wasm'] });
          const mask = async e => { const r = await dec.run({ input_points: new ort.Tensor('float32', new Float32Array([224*s, 295*s]), [1,1,1,2]),
              input_labels: new ort.Tensor('int64', BigInt64Array.from([1n]), [1,1,1]),
              image_embeddings: e.image_embeddings, image_positional_embeddings: e.image_positional_embeddings });
            return r.pred_masks.data; };
          const out = {}; let ref;
          for (const [label, file, ep] of [['int8 wasm (current)', 'vision_encoder_quantized.onnx', 'wasm'],
                                           ['fp32 webgpu', 'vision_encoder.onnx', 'webgpu']]) {
            console.log('start ' + label);
            try {
              const sess = await ort.InferenceSession.create(await buf(file), { executionProviders: [ep] });
              let t = performance.now(); const e = await sess.run(feeds()); const ms = performance.now() - t;
              // copy GPU outputs to CPU tensors for the wasm decoder
              const cpu = {}; for (const k of ['image_embeddings', 'image_positional_embeddings']) cpu[k] = new ort.Tensor('float32', await e[k].getData(), e[k].dims);
              const m = await mask(cpu);
              if (!ref) { ref = { m, emb: cpu.image_embeddings.data }; out[label] = `${(ms/1000).toFixed(1)}s (reference)`; continue; }
              let inter = 0, uni = 0, maxd = 0;
              for (let i = 0; i < m.length; i++) { const a = ref.m[i] > 0, b2 = m[i] > 0; inter += a && b2; uni += a || b2; }
              for (let i = 0; i < ref.emb.length; i++) maxd = Math.max(maxd, Math.abs(ref.emb[i] - cpu.image_embeddings.data[i]));
              out[label] = `${(ms/1000).toFixed(1)}s, mask agreement IoU ${(inter/uni).toFixed(3)}, max emb diff ${maxd.toFixed(3)}`;
            } catch (err) { out[label] = 'FAILED: ' + err.message.slice(0, 200); }
          }
          return out; }""", img))
        print("done", flush=True)
        b.close()
finally:
    srv.terminate()
