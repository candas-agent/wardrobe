import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
os.makedirs("/tmp/wardrobe-shots", exist_ok=True)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def shot(page, name, full=True): page.screenshot(path=f"/tmp/wardrobe-shots/{name}.png", full_page=full)
def tags(page):
    page.wait_for_function("document.querySelector('#typeSuggest .chip') && !document.querySelector('#typeSuggest .status')", timeout=120000)
    return (page.eval_on_selector_all("#typeSuggest .chip", "els => els.map(e => e.textContent.trim())"),
            page.eval_on_selector_all("#colourSuggest .chip", "els => els.map(e => e.textContent.trim())"))
def tap(page, x, y):  # x, y in photo pixels (1200x900)
    r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
    page.mouse.click(r[0] + x / 1200 * r[2], r[1] + y / 900 * r[3])
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}")); page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.goto("http://localhost:8765/#/settings"); page.click("#dl")
        page.wait_for_function("document.querySelector('#dlStatus')?.textContent.match(/Ready|Failed/)", timeout=600000)
        print("models:", page.text_content("#dlStatus"))
        page.goto("http://localhost:8765/#/add"); page.wait_for_selector("#gallery", state="attached")
        page.set_input_files("#gallery", ["/tmp/flatlay.jpg"])
        page.wait_for_selector("#stage"); print("whole photo:", tags(page))
        page.wait_for_timeout(500)
        t0 = time.time(); tap(page, 224, 295)
        page.wait_for_selector("#cands .cand", timeout=60000); print(f"jeans tap -> outline in {time.time()-t0:.1f}s")
        print("  jeans cut-out:", tags(page)); shot(page, "10-tap-jeans")
        for i in range(3):
            page.click(f"#cands .cand:nth-child({i+1})"); print(f"  outline {i}:", tags(page))
        page.click("#reset"); tags(page)
        tap(page, 595, 285); page.wait_for_selector("#cands .cand"); page.wait_for_timeout(300)
        print("  sweater cut-out:", tags(page)); shot(page, "11-tap-sweater")
        page.click("#mode .chip:nth-child(2)"); tap(page, 595, 120)  # exclude the head
        page.wait_for_function("document.querySelectorAll('#stage').length && true"); page.wait_for_timeout(1500)
        print("  sweater minus head:", tags(page)); shot(page, "12-exclude", full=False)
        page.click("#save"); page.wait_for_selector("#gallery", state="attached")
        page.goto("http://localhost:8765/#/"); page.wait_for_selector("#grid .card"); shot(page, "13-grid")
        page.click("#grid .card"); page.wait_for_selector("#toggleOrig"); print("original kept: yes")
        b.close()
finally:
    srv.terminate(); print("\n".join(l for l in logs if "[log]" not in l) or "no console warnings/errors")
