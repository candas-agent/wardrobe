import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
GPU = sys.argv[1] == "gpu"
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8773", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def tap(page, x, y):
    r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
    page.mouse.click(r[0] + x / 1200 * r[2], r[1] + y / 900 * r[3])
args = ["--ignore-certificate-errors"] + (["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader"] if GPU else [])
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=args)
        ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True); page = ctx.new_page(); page.set_default_timeout(1800000)
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:160]}") if m.type in ("error", "warning") and "VerifyEachNode" not in m.text else None)
        page.goto("http://localhost:8773/"); page.wait_for_selector("#modelBar:not([hidden])", timeout=20000)
        print("bar:", page.text_content("#modelText"))
        page.wait_for_selector("#modelBar[hidden]", state="attached")
        page.reload(); page.wait_for_selector(".topbar")
        page.goto("http://localhost:8773/#/settings"); page.wait_for_selector(".panel")
        print("settings:", page.inner_text(".panel >> nth=1").replace("\n", " | "))
        page.goto("http://localhost:8773/#/")
        page.set_input_files(".add-files >> nth=0", ["/tmp/flatlay.jpg"]); page.wait_for_selector("#stage")
        t0 = time.time(); tap(page, 224, 295); page.wait_for_selector("#cands .cand")
        print(f"outline after {time.time()-t0:.0f}s (software GPU is slow; real GPUs are not)" if GPU else f"outline after {time.time()-t0:.1f}s")
        page.wait_for_function("!document.querySelector('#typeSuggest .status')")
        print("jeans:", page.eval_on_selector_all("#typeSuggest .chip", "e => e.map(x => x.textContent.trim())"),
              "| outline areas:", page.evaluate("document.querySelectorAll('#cands canvas').length"),
              "| gpu state:", page.evaluate("localStorage.getItem('wardrobe-gpu')"))
        page.screenshot(path=f"/tmp/wardrobe-shots/110-{'gpu' if GPU else 'cpu'}-tap.png")
        if GPU:
            page.goto("http://localhost:8773/#/settings"); page.wait_for_selector("#gpu"); page.click("#gpu"); page.wait_for_load_state()
            page.goto("http://localhost:8773/#/settings"); page.wait_for_selector(".panel")
            print("after switching off:", page.inner_text(".panel >> nth=1").replace("\n", " | "))
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console warnings/errors")
