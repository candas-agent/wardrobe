import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
S = "/tmp/wardrobe-samples/"
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        page = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}")); page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        def add(path, save=True):
            page.goto("http://localhost:8765/#/"); page.goto("http://localhost:8765/#/add"); page.wait_for_selector("#gallery", state="attached")
            page.set_input_files("#gallery", [path]); page.wait_for_selector("#stage")
            notice = page.query_selector(".notice")
            msg = notice.inner_text().replace("\n", " | ") if notice else "no warning"
            if save:
                if notice: page.screenshot(path="/tmp/wardrobe-shots/70-dupe.png")
                page.click("#save"); page.wait_for_selector("#gallery", state="attached")
            return msg
        page.goto("http://localhost:8765/"); page.wait_for_timeout(500)
        print("1 flatlay (new):        ", add("/tmp/flatlay.jpg"))
        print("2 dress (new):          ", add(S + "Dresses.jpg"))
        print("3 flatlay same file:    ", add("/tmp/flatlay.jpg"))
        print("4 flatlay resized+q70:  ", add("/tmp/flatlay_resaved.jpg", save=False))
        for f in ["Jeans.jpg", "Skirts.jpg", "Sweaters.jpg", "Casual_Shoes.jpg"]:
            print(f"5 {f:22s}", add(S + f, save=False))
        # backfill: strip fingerprints, reload, check they come back
        page.goto("http://localhost:8765/")
        page.evaluate("""() => new Promise(res => { const r = indexedDB.open('wardrobe'); r.onsuccess = () => {
            const st = r.result.transaction('items', 'readwrite').objectStore('items'); const g = st.getAll();
            g.onsuccess = () => { g.result.forEach(i => { delete i.source; st.put(i); }); st.transaction.oncomplete = res; }; }; })""")
        page.reload(); page.wait_for_timeout(2500)
        print("backfill:", page.evaluate("""() => new Promise(res => { const r = indexedDB.open('wardrobe'); r.onsuccess = () => {
            const g = r.result.transaction('items').objectStore('items').getAll(); g.onsuccess = () => res(g.result.map(i => !!i.source?.tiny)); }; })"""))
        print("after backfill, resaved flatlay:", add("/tmp/flatlay_resaved.jpg", save=False))
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console warnings/errors")
