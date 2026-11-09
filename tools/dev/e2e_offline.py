import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8767", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def tap(page, x, y):
    r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
    page.mouse.click(r[0] + x / 1200 * r[2], r[1] + y / 900 * r[3])
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True); page = ctx.new_page(); page.set_default_timeout(300000)
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}")); page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.goto("http://localhost:8767/"); page.wait_for_selector("#modelBar[hidden]", state="attached")
        print("ort cached:", page.evaluate("caches.open('wardrobe-app-v8').then(c => c.keys()).then(k => k.map(r => r.url).filter(u => u.includes('onnxruntime')).map(u => u.split('/').pop()))"))
        page.reload(); page.wait_for_selector(".topbar")
        print("online, isolated:", page.evaluate("crossOriginIsolated"), "threads:", page.evaluate("import('./models.js').then(m => m.THREADS)"))
        ctx.set_offline(True); page.reload(); page.wait_for_selector(".topbar")
        print("offline reload ok, isolated:", page.evaluate("crossOriginIsolated"))
        page.set_input_files(".add-files >> nth=0", ["/tmp/flatlay.jpg"]); page.wait_for_selector("#stage")
        page.wait_for_function("document.querySelector('#typeSuggest .chip') && !document.querySelector('#typeSuggest .status')")
        print("offline type:", page.eval_on_selector_all("#typeSuggest .chip", "e => e.map(x => x.textContent.trim())"))
        tap(page, 224, 295); page.wait_for_selector("#cands .cand"); page.wait_for_function("!document.querySelector('#typeSuggest .status')")
        print("offline tap:", page.eval_on_selector_all("#typeSuggest .chip", "e => e.map(x => x.textContent.trim())"), "| status:", page.text_content("#segStatus"))
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console warnings/errors")
