import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        page = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}")); page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.goto("http://localhost:8765/#/add"); page.wait_for_selector("#gallery", state="attached")
        page.set_input_files("#gallery", ["/tmp/wardrobe-samples/Dresses.jpg"]); page.wait_for_selector("#save"); page.click("#save")
        page.wait_for_selector("#gallery", state="attached")
        for label, url in [("during download", None)]:
            page.goto("http://localhost:8765/#/"); page.wait_for_selector("#grid .card"); page.click("#grid .card"); page.wait_for_selector(".topbar")
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)"); page.wait_for_timeout(300)
            box = page.eval_on_selector("#save", "e => e.getBoundingClientRect().top")
            print(f"{label}: Save button top after scrolling = {box:.0f}px, visible = {page.is_visible('#save')}")
            page.screenshot(path="/tmp/wardrobe-shots/40-topbar-dl.png")
        page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        page.goto("http://localhost:8765/#/"); page.wait_for_selector("#grid .card"); page.click("#grid .card"); page.wait_for_selector(".topbar")
        page.fill("#name", "Red party dress")
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)"); page.wait_for_timeout(300)
        print(f"after download: Save top = {page.eval_on_selector('#save', 'e => e.getBoundingClientRect().top'):.0f}px")
        page.screenshot(path="/tmp/wardrobe-shots/41-topbar.png")
        page.click("#save"); page.wait_for_selector("#grid .card")
        print("saved name in grid:", page.text_content("#grid .card .meta"))
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console warnings/errors")
