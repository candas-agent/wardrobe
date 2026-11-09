import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys, base64, json
from playwright.sync_api import sync_playwright
src = open("e2e_trips.py").read()
exec(src[src.index("S = "):src.index("try:")].replace("S = ", "S = ", 1))  # ITEMS, OUTFITS, SEED, b64
ITEMS.append(("jacket", "jacket", "khaki", "Field jacket", "Sweaters.jpg"))
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
FIT = """() => { const cars = [...document.querySelectorAll('.carousel')], tabs = document.querySelector('.tabs').getBoundingClientRect().top;
  const last = cars.at(-1).getBoundingClientRect().bottom;
  return { rows: cars.map(c => c.dataset.layer).join(','), slot: getComputedStyle(cars[0]).getPropertyValue('--slot-w'),
           lastBottom: Math.round(last), tabsTop: Math.round(tabs), fits: last <= tabs } }"""
PICKS = "() => [...document.querySelectorAll('.carousel')].map(c => c.dataset.layer + '=' + (c.querySelector('.slot.on img')?.alt || 'none'))"
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        for vw, vh in [(390, 844), (360, 640)]:
            page = b.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
            page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}")); page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type == "error" and "404" not in m.text else None)
            page.on("dialog", lambda d: d.accept())
            page.goto("http://localhost:8765/404-blank"); page.evaluate(SEED, [[list(i[:4]) + [b64(i[4])] for i in ITEMS], OUTFITS])
            print(f"--- viewport {vw}x{vh}")
            page.goto("http://localhost:8765/#/outfit/new"); page.wait_for_selector(".carousel .slot.on"); page.wait_for_timeout(300)
            print("default:", page.evaluate(FIT), "| toggles:", page.eval_on_selector_all("#layerToggles .chip", "e => e.map(x => x.textContent)"))
            if vw == 390: page.screenshot(path="/tmp/wardrobe-shots/100-3rows.png")
            page.click("#layerToggles .chip[data-v=outer]"); page.wait_for_timeout(300)
            print("+outerwear:", page.evaluate(FIT), page.evaluate(PICKS))
            page.click("#layerToggles .chip[data-v=acc]"); page.wait_for_timeout(300)
            print("+accessories:", page.evaluate(FIT))
            if vw == 390: page.screenshot(path="/tmp/wardrobe-shots/101-5rows.png")
            page.click("#layerToggles .chip[data-v=acc]"); page.wait_for_timeout(200)
            page.fill("#oname", "With jacket"); page.click("#osave"); page.wait_for_selector(".outfit")
            saved = page.evaluate("""() => new Promise(res => { const r = indexedDB.open('wardrobe'); r.onsuccess = () => {
              const g = r.result.transaction('outfits').objectStore('outfits').getAll(); g.onsuccess = () => res(g.result.find(o => o.name === 'With jacket')); }; })""")
            print("saved items:", saved["itemIds"])
            page.goto(f"http://localhost:8765/#/outfit/{saved['id']}"); page.wait_for_selector(".carousel .slot.on")
            print("reopened rows:", page.evaluate(FIT)["rows"], "| toggles:", page.eval_on_selector_all("#layerToggles .chip", "e => e.map(x => x.textContent)"))
            page.click("#layerToggles .chip[data-v=outer]"); page.click("#osave"); page.wait_for_selector(".outfit")
            saved = page.evaluate(f"""() => new Promise(res => {{ const r = indexedDB.open('wardrobe'); r.onsuccess = () => {{
              const g = r.result.transaction('outfits').objectStore('outfits').get('{saved['id']}'); g.onsuccess = () => res(g.result); }}; }})""")
            print("outerwear off -> saved items:", saved["itemIds"])
            page.context.close()
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console errors")
