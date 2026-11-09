import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
from playwright.sync_api import sync_playwright
import subprocess, sys, time
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
try:
  with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(ignore_https_errors=True); page = ctx.new_page()
    page.on("requestfailed", lambda r: print("FAILED", r.url, r.failure))
    page.on("response", lambda r: print(r.status, r.url) if "jsdelivr" in r.url or "huggingface" in r.url else None)
    page.goto("http://localhost:8765/")
    print(page.evaluate("""async () => { try { const r = await fetch('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs'); return r.status + ' ' + r.headers.get('content-type'); } catch (e) { return 'ERR ' + e.message; } }"""))
    b.close()
finally: srv.terminate()
