import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys, glob
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def bottom_then_top(page, sel):
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)"); page.wait_for_timeout(300)
    return round(page.eval_on_selector(sel, "e => e.getBoundingClientRect().top")), page.evaluate("Math.round(scrollY)")
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        page = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}")); page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        page.goto("http://localhost:8765/#/add"); page.wait_for_selector("#gallery", state="attached")
        files = sorted(glob.glob("/tmp/wardrobe-samples/*.jpg"))
        page.set_input_files("#gallery", files)
        for i in range(len(files)):
            page.wait_for_function(f"document.querySelector('.topbar .title')?.textContent.includes('{i+1} of {len(files)}')")
            page.wait_for_function("document.querySelector('#typeSuggest .chip') && !document.querySelector('#typeSuggest .status')", timeout=120000)
            top, sy = bottom_then_top(page, "#save")
            if i == 0:
                print(f"add title: {page.text_content('.topbar .title')!r} | Save top after scroll: {top}px (scrollY {sy})")
                page.screenshot(path="/tmp/wardrobe-shots/50-add-bar.png")
            page.click("#save")
        page.wait_for_selector("#gallery", state="attached"); print("all", len(files), "saved via top bar")
        page.goto("http://localhost:8765/#/outfit/new"); page.wait_for_selector("#ogrid .card")
        page.fill("#oname", "Test"); page.click("#ogrid .card >> nth=0"); page.click("#ogrid .card >> nth=3")
        top, sy = bottom_then_top(page, "#osave"); print(f"builder: Save top after scroll {top}px (scrollY {sy}), delete shown: {page.query_selector('#odel') is not None}")
        page.screenshot(path="/tmp/wardrobe-shots/51-builder-bar.png")
        page.click("#osave"); page.wait_for_selector(".outfit"); page.click(".outfit"); page.wait_for_selector("#osave")
        print("existing outfit: delete shown:", page.query_selector("#odel") is not None)
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console warnings/errors")
