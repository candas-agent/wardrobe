import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys, shutil, threading, functools, http.server
from playwright.sync_api import sync_playwright
D = "/tmp/wardrobe-update"; shutil.rmtree(D, ignore_errors=True)
shutil.copytree(_REPO, D, ignore=shutil.ignore_patterns(".git", "tools"))
class H(http.server.SimpleHTTPRequestHandler):  # mimic GitHub Pages caching
    def end_headers(self): self.send_header("Cache-Control", "max-age=600"); super().end_headers()
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), functools.partial(H, directory=D))
threading.Thread(target=srv.serve_forever, daemon=True).start()
def publish(version):
    for f, a, b in [("sw.js", f"wardrobe-app-v{version-1}", f"wardrobe-app-v{version}"),
                    ("index.html", f"<title>Wardrobe{' v'+str(version-1) if version > 9 else ''}</title>", f"<title>Wardrobe v{version}</title>")]:
        s = open(f"{D}/{f}").read(); assert a in s, (f, a); open(f"{D}/{f}", "w").write(s.replace(a, b))
def come_back(page):  # what visibilitychange does
    page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"]); page = b.new_context().new_page()
        page.goto("http://127.0.0.1:8766/"); page.wait_for_function("navigator.serviceWorker.controller", timeout=15000) if False else page.wait_for_timeout(2000)
        page.reload(); page.wait_for_function("!!navigator.serviceWorker.controller"); print("installed, title:", page.title())
        publish(9); come_back(page)
        page.wait_for_function("document.title === 'Wardrobe v9'", timeout=15000); print("on wardrobe page -> auto reloaded to:", page.title())
        page.goto("http://127.0.0.1:8766/#/outfit/new"); page.wait_for_selector("#osave")
        publish(10); come_back(page); page.wait_for_timeout(4000)
        print("on outfit editor -> still:", page.title(), "(no reload while busy)")
        page.click('a[data-tab="wardrobe"]'); page.wait_for_function("document.title === 'Wardrobe v10'", timeout=15000)
        print("left editor -> reloaded to:", page.title())
        b.close()
finally:
    srv.shutdown()
