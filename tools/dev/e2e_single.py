import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
exec(open("e2e_simple.py").read().split("try:")[0].split("srv = ")[0])
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
src = open("e2e_simple.py").read(); exec(src[src.index("def shot"):src.index("try:")])
dots = "document.querySelectorAll('#cands .cand').length"
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        page = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}")); page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000); page.wait_for_timeout(500)
        page.goto("http://localhost:8765/#/add"); page.wait_for_selector("#gallery", state="attached")
        page.set_input_files("#gallery", ["/tmp/flatlay.jpg"]); page.wait_for_selector("#stage")
        print("whole photo:", tags(page), "| buttons near photo:", page.query_selector("#reset, #mode") is not None)
        tap(page, 224, 295); page.wait_for_selector("#cands .cand"); print("tap jeans:", tags(page))
        tap(page, 595, 285); page.wait_for_timeout(2500); print("tap sweater:", tags(page))
        shot(page, "30-single", full=False)
        tap(page, 595, 285); page.wait_for_timeout(1500); print("tap dot again:", tags(page), "| outlines:", page.evaluate(dots))
        b.close()
finally:
    srv.terminate(); print("\n".join(l for l in logs if "[log]" not in l) or "no console warnings/errors")
