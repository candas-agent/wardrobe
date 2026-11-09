import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys, glob
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
PICKS = """() => [...document.querySelectorAll('.carousel')].map(c => {
  const on = c.querySelector('.slot.on'); const r = c.getBoundingClientRect(), s = on.getBoundingClientRect();
  return c.dataset.layer + '=' + (on.querySelector('img')?.alt || 'none') + ' (off-centre ' + Math.round(s.left + s.width/2 - (r.left + r.width/2)) + 'px)' })"""
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        page = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}")); page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        page.goto("http://localhost:8765/"); page.wait_for_selector(".add-files", state="attached")
        files = sorted(glob.glob("/tmp/wardrobe-samples/*.jpg")); page.set_input_files(".add-files", files)
        for i in range(len(files)):
            page.wait_for_function(f"document.querySelector('.topbar .title')?.textContent.includes('{i+1} of')")
            page.wait_for_function("document.querySelector('#typeSuggest .chip') && !document.querySelector('#typeSuggest .status')", timeout=120000)
            page.click("#save")
        page.wait_for_selector("#grid .card")
        page.goto("http://localhost:8765/#/outfit/new"); page.wait_for_selector(".carousel .slot.on")
        print("new outfit:", page.evaluate(PICKS)); page.screenshot(path="/tmp/wardrobe-shots/60-carousel.png")
        # swipe the bottoms row left by one slot via touch-like scroll, and tap a side slot in tops
        page.eval_on_selector('.carousel[data-layer="bottom"]', "c => c.scrollBy({ left: 102, behavior: 'instant' })"); page.wait_for_timeout(600)
        page.click('.carousel[data-layer="top"] .slot.none'); page.wait_for_timeout(900)
        print("after swipe + tap:", page.evaluate(PICKS)); page.screenshot(path="/tmp/wardrobe-shots/61-carousel-changed.png")
        page.fill("#oname", "Dress day"); page.click("#osave"); page.wait_for_selector(".outfit")
        print("list:", page.text_content(".outfit").split()[:6], "| thumbs:", page.eval_on_selector_all(".outfit .thumbs img", "e => e.map(x => x.alt).length"))
        page.click(".outfit"); page.wait_for_selector(".carousel .slot.on"); page.wait_for_timeout(300)
        print("reopened:", page.evaluate(PICKS))
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console warnings/errors")
