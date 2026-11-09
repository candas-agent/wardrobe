import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def shot(page, name, full=True): page.screenshot(path=f"/tmp/wardrobe-shots/{name}.png", full_page=full)
def tags(page):
    page.wait_for_function("document.querySelector('#typeSuggest .chip') && !document.querySelector('#typeSuggest .status')", timeout=300000)
    return (page.eval_on_selector_all("#typeSuggest .chip", "els => els.map(e => e.textContent.trim())"),
            page.eval_on_selector_all("#colourSuggest .chip", "els => els.map(e => e.textContent.trim())"))
def tap(page, x, y):
    r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
    page.mouse.click(r[0] + x / 1200 * r[2], r[1] + y / 900 * r[3])
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}")); page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.goto("http://localhost:8765/")
        page.wait_for_selector("#modelBar:not([hidden])", timeout=10000); page.wait_for_timeout(3000)
        print("bar:", page.text_content("#modelText")); shot(page, "20-bar", full=False)
        # add a photo while the download is still running: tagging should wait, not fail
        page.goto("http://localhost:8765/#/add"); page.wait_for_selector("#gallery", state="attached")
        print("add page buttons:", page.eval_on_selector_all("#view .btn", "e => e.map(x => x.textContent.trim())"))
        page.set_input_files("#gallery", ["/tmp/flatlay.jpg"]); page.wait_for_selector("#stage")
        print("mode buttons present:", page.query_selector("#mode") is not None)
        tap(page, 224, 295)  # tap jeans during download
        t0 = time.time(); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        print(f"bar hidden after download ({time.time()-t0:.0f}s more)")
        page.wait_for_selector("#cands .cand", timeout=120000); print("jeans (tapped during download):", tags(page))
        tap(page, 224, 160)  # second tap on the jeans' upper part
        page.wait_for_timeout(2500); print("two taps:", tags(page), "dots:", page.evaluate("document.querySelectorAll('#cands .cand').length"))
        shot(page, "21-two-taps", full=False)
        tap(page, 224, 160); page.wait_for_timeout(2500)  # tap the dot again -> removes it
        print("after removing dot:", tags(page))
        tap(page, 224, 295); page.wait_for_timeout(1500)  # remove last dot -> back to whole photo
        print("no dots -> reset visible:", page.is_visible("#reset"), "| cands:", page.evaluate("document.querySelectorAll('#cands .cand').length"), "|", tags(page))
        page.goto("http://localhost:8765/#/settings"); page.wait_for_selector(".panel")
        print("settings:", page.eval_on_selector_all(".panel p", "e => e.map(x => x.textContent.trim())")[1])
        page.goto("http://localhost:8765/"); page.wait_for_timeout(1500)
        print("bar on 2nd open hidden:", page.eval_on_selector("#modelBar", "e => e.hidden"))
        b.close()
finally:
    srv.terminate(); print("\n".join(l for l in logs if "[log]" not in l) or "no console warnings/errors")
