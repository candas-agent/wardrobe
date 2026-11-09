import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, glob, sys, os
from playwright.sync_api import sync_playwright
os.makedirs("/tmp/wardrobe-shots", exist_ok=True)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
logs = []
def shot(page, name): page.screenshot(path=f"/tmp/wardrobe-shots/{name}.png", full_page=True)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True,
                            has_touch=True, ignore_https_errors=True, accept_downloads=True)
        page = ctx.new_page()
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.goto("http://localhost:8765/"); page.wait_for_selector("h1"); shot(page, "01-empty")

        page.goto("http://localhost:8765/#/settings"); page.click("#dl")
        t0 = time.time()
        page.wait_for_function("document.querySelector('#dlStatus')?.textContent.match(/Ready|Failed/)", timeout=600000)
        print("model:", page.text_content("#dlStatus"), f"{time.time()-t0:.0f}s")

        page.goto("http://localhost:8765/#/add"); page.wait_for_selector("#gallery", state="attached")
        files = sorted(glob.glob("/tmp/wardrobe-samples/*.jpg"))
        page.set_input_files("#gallery", files)
        for i, f in enumerate(files):
            page.wait_for_function("document.querySelector('#typeSuggest .chip')", timeout=120000)
            chips = page.eval_on_selector_all("#typeSuggest .chip", "els => els.map(e => e.textContent.trim())")
            cols = page.eval_on_selector_all("#colourSuggest .chip", "els => els.map(e => e.textContent.trim())")
            print(os.path.basename(f), "| type:", chips, "| colour:", cols, "| selected:", page.input_value("#type"))
            if i == 0: shot(page, "02-add-form")
            page.click("#save"); time.sleep(0.4)
        page.wait_for_selector("#gallery", state="attached")

        page.goto("http://localhost:8765/#/"); page.wait_for_selector("#grid .card"); shot(page, "03-wardrobe")
        page.fill("#q", "jeans"); time.sleep(0.2)
        print("search 'jeans':", page.eval_on_selector_all("#grid .card", "e => e.length"), "cards")
        page.fill("#q", "")

        page.goto("http://localhost:8765/#/outfit/new"); page.wait_for_selector("#ogrid .card")
        page.fill("#oname", "Weekend")
        cards = page.query_selector_all("#ogrid .card"); cards[0].click(); cards[2].click()
        shot(page, "04-builder"); page.click("#osave"); page.wait_for_selector(".outfit"); shot(page, "05-outfits")

        page.goto("http://localhost:8765/#/settings"); page.wait_for_selector("#exp")
        with page.expect_download() as dl: page.click("#exp")
        path = dl.value.path(); print("backup:", dl.value.suggested_filename, os.path.getsize(path), "bytes")
        shot(page, "06-settings")

        # offline reload: service worker should serve the app
        page.goto("http://localhost:8765/#/"); page.wait_for_timeout(1500)
        ctx.set_offline(True); page.reload(); page.wait_for_selector("#grid .card", timeout=10000)
        print("offline reload ok:", page.eval_on_selector_all("#grid .card", "e => e.length"), "cards")
        page.goto("http://localhost:8765/#/add"); page.wait_for_selector("#gallery", state="attached")
        page.set_input_files("#gallery", files[:1])
        page.wait_for_function("document.querySelector('#typeSuggest .chip')", timeout=60000)
        print("offline classify ok:", page.eval_on_selector_all("#typeSuggest .chip", "els => els.map(e => e.textContent.trim())"))
        b.close()
finally:
    srv.terminate()
    print("\n".join(l for l in logs if "[log]" not in l) or "no console warnings/errors")
