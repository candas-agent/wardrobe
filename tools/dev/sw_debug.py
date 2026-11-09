import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8778", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"]); ctx = b.new_context(); page = ctx.new_page()
        logs = []; page.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:200]}"))
        ctx.on("serviceworker", lambda w: w.on("console", lambda m: logs.append(f"[sw {m.type}] {m.text[:200]}")) if hasattr(w, "on") else None)
        page.goto("http://localhost:8778/")
        for t in range(10):
            st = page.evaluate("navigator.serviceWorker.getRegistration().then(r => r ? [r.installing?.state, r.waiting?.state, r.active?.state] : 'none')")
            print(f"{t*2}s: reg {st} controller {page.evaluate('!!navigator.serviceWorker.controller')}"); 
            if st and st[2] == "activated": break
            page.wait_for_timeout(2000)
        page.reload(); page.wait_for_timeout(1000)
        print("after reload isolated:", page.evaluate("crossOriginIsolated"), "| controller:", page.evaluate("!!navigator.serviceWorker.controller"))
        print("\n".join(logs[-8:]))
        b.close()
finally:
    srv.terminate()
