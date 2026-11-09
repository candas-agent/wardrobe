import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
src = open("e2e_simple.py").read(); exec(src[src.index("def shot"):src.index("def tap")])
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
W, H = 552, 735
def at(page, x, y):
    r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
    return r[0] + x / W * r[2], r[1] + y / H * r[3]
def tap(page, x, y): page.mouse.click(*at(page, x, y))
def hold(page, x, y):
    page.mouse.move(*at(page, x, y)); page.mouse.down(); page.wait_for_timeout(700); page.mouse.up()
status = lambda page: page.text_content("#segStatus")
def settle(page, before):
    page.wait_for_function("t => { const s = document.querySelector('#segStatus').textContent; return s !== t && s.startsWith('Pick') }", arg=before, timeout=300000)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        page = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}")); page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000); page.wait_for_timeout(500)
        page.set_input_files(".add-files", ["/tmp/jacket.png"]); page.wait_for_selector("#stage")
        s = status(page); tap(page, 120, 380); settle(page, s); print("tap left :", status(page), tags(page)); shot(page, "40-jacket-left", full=False)
        s = status(page); hold(page, 430, 380); settle(page, s); print("hold right:", status(page), tags(page)); shot(page, "41-jacket-both", full=False)
        s = status(page); tap(page, 430, 380); settle(page, s); print("tap R dot:", status(page))
        s = status(page); tap(page, 120, 380); page.wait_for_timeout(1500); print("tap L dot:", status(page), "| outlines:", page.evaluate("document.querySelectorAll('#cands .cand').length"))
        s = status(page); hold(page, 120, 380); page.wait_for_timeout(1500); print("hold with no selection:", status(page))
        b.close()
finally:
    srv.terminate(); print("\n".join(l for l in logs if "[log]" not in l) or "no console warnings/errors")
