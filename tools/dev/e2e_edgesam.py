import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8775", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
OLD = ["https://huggingface.co/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/vision_encoder_quantized.onnx",
       "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/prompt_encoder_mask_decoder_quantized.onnx"]
def tap(page, x, y):
    r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
    page.mouse.click(r[0] + x / 1200 * r[2], r[1] + y / 900 * r[3])
TAGS = "e => e.map(x => x.textContent.trim())"
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True); page = ctx.new_page(); page.set_default_timeout(600000)
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:150]}") if m.type in ("error", "warning") and "adapters" not in m.text and "404" not in m.text else None)
        page.goto("http://localhost:8775/404")
        page.evaluate("""async (old) => { localStorage.setItem('wardrobe-gpu', 'failed'); localStorage.setItem('wardrobe-gpu-reason', 'old SlimSAM failure');
          const c = await caches.open('wardrobe-model-v1'); for (const u of old) await c.put(u, new Response('old model')); }""", OLD)
        page.goto("http://localhost:8775/"); page.wait_for_selector("#modelBar:not([hidden])", timeout=20000)
        print("bar:", page.text_content("#modelText"), "| gpu setting after start:", page.evaluate("localStorage.getItem('wardrobe-gpu')"))
        page.wait_for_selector("#modelBar[hidden]", state="attached")
        print("cached models:", page.evaluate("caches.open('wardrobe-model-v1').then(c => c.keys()).then(k => k.map(r => r.url.split('/').slice(-1)[0]))"))
        page.reload(); page.wait_for_selector(".topbar")
        page.goto("http://localhost:8775/#/settings"); page.wait_for_selector(".panel")
        print("settings:", page.inner_text(".panel >> nth=1").replace("\n", " | ")[:300])
        page.goto("http://localhost:8775/#/")
        page.set_input_files(".add-files >> nth=0", ["/tmp/flatlay.jpg"]); page.wait_for_selector("#stage")
        page.wait_for_function("document.querySelector('#typeSuggest .chip') && !document.querySelector('#typeSuggest .status')")
        print("whole photo:", page.eval_on_selector_all('#typeSuggest .chip', TAGS))
        page.wait_for_timeout(6000)  # the photo gets ready while the user looks at it
        for name, (x, y) in [("jeans (on a leg)", (190, 330)), ("sweater", (595, 285)), ("shoe", (985, 662))]:
            t0 = time.time(); tap(page, x, y)
            page.wait_for_function("document.querySelectorAll('#cands .cand').length && document.querySelector('#segStatus').textContent.startsWith('Pick')")
            dt = time.time() - t0
            page.wait_for_function("!document.querySelector('#typeSuggest .status')")
            print(f"{name}: outline in {dt:.1f}s, {page.evaluate('document.querySelectorAll(\"#cands .cand\").length')} outlines | type {page.eval_on_selector_all('#typeSuggest .chip', TAGS)} | colour {page.eval_on_selector_all('#colourSuggest .chip', TAGS)}")
            page.screenshot(path=f"/tmp/wardrobe-shots/120-edgesam-{name.split()[0]}.png")
        page.click("#save"); page.wait_for_selector("#grid .card")
        print("saved; grid items:", page.evaluate("document.querySelectorAll('#grid .card').length"))
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console warnings/errors")
