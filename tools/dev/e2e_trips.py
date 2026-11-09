import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys, base64, json
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []; S = "/tmp/wardrobe-samples/"
b64 = lambda f: base64.b64encode(open(S + f, "rb").read()).decode()
ITEMS = [  # id, type, colour, name, image
  ("tee", "tshirt", "white", "White tee", "Sweaters.jpg"), ("jumper", "jumper", "black", "Black jumper", "Sweaters.jpg"),
  ("jeans", "jeans", "navy", "Jeans", "Jeans.jpg"), ("skirt", "skirt", "navy", "Denim skirt", "Skirts.jpg"),
  ("dress", "dress", "red", "Red dress", "Dresses.jpg"), ("sneakers", "sneakers", "black", "Sneakers", "Casual_Shoes.jpg"),
  ("boots", "boots", "brown", "Boots", "Casual_Shoes.jpg"), ("heels", "heels", "black", "Heels", "Casual_Shoes.jpg"),
  ("scarf", "scarf", "grey", "Scarf", "Sweaters.jpg")]
OUTFITS = [("o1", "Casual", ["tee", "jeans", "sneakers"]), ("o2", "Skirt day", ["jumper", "skirt", "boots"]),
           ("o3", "Dinner", ["dress", "sneakers"]), ("o4", "Cosy", ["jumper", "jeans", "sneakers"]), ("o5", "Party", ["tee", "skirt", "heels"])]
SEED = """async ([items, outfits]) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wardrobe', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('items', { keyPath: 'id' }); r.result.createObjectStore('outfits', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const blobs = await Promise.all(items.map(async i => (await fetch('data:image/jpeg;base64,' + i[4])).blob()));
  const tx = db.transaction(['items', 'outfits'], 'readwrite');
  let t = 0;
  for (const [k, [id, type, colour, name]] of items.entries()) {
    const blob = blobs[k];
    tx.objectStore('items').put({ id, type, colour, colour2: '', name, notes: '', photo: blob, thumb: blob, createdAt: ++t });
  }
  for (const [id, name, itemIds] of outfits) tx.objectStore('outfits').put({ id, name, itemIds, createdAt: ++t });
  await new Promise(r => tx.oncomplete = r); db.close(); }"""
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}")); page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.on("dialog", lambda d: d.accept())
        page.goto("http://localhost:8765/404-blank"); page.evaluate(SEED, [[list(i[:4]) + [b64(i[4])] for i in ITEMS], OUTFITS])
        page.goto("http://localhost:8765/"); page.wait_for_selector("#grid .card")
        print("v1 db upgraded, items kept:", page.evaluate("document.querySelectorAll('#grid .card').length"))
        page.click('a[data-tab="trips"]'); page.wait_for_selector("#newTrip")
        print("tabs:", page.eval_on_selector_all(".tabs a", "e => e.map(x => x.textContent.trim())"))
        page.click("#newTrip"); page.wait_for_selector("#tname")
        page.fill("#tname", "Lisbon"); page.fill("#tstart", "2026-11-05"); page.dispatch_event("#tstart", "change")
        page.fill("#tend", "2026-11-07"); page.dispatch_event("#tend", "change")
        days = page.eval_on_selector_all(".day-head strong", "e => e.map(x => x.textContent)"); print("days:", days)
        def plan(day_idx, outfit):
            page.click(f".day >> nth={day_idx} >> [data-add]"); page.wait_for_selector(".sheet")
            page.click(f".sheet button.planned:has-text('{outfit}')"); page.wait_for_selector(".sheet", state="detached")
        plan(0, "Casual"); plan(1, "Skirt day"); plan(1, "Dinner"); plan(2, "Casual")
        print("planned:", page.eval_on_selector_all(".day", "e => e.map(d => [...d.querySelectorAll('.planned .pl-name')].map(s => s.textContent).join('+') || '-')"))
        page.screenshot(path="/tmp/wardrobe-shots/90-plan.png", full_page=True)
        page.click("#tseg .chip[data-v=pack]"); page.wait_for_selector(".pack-row")
        rows = page.eval_on_selector_all(".pack-row", "e => e.map(r => r.innerText.replace(/\\n/g, ' '))"); print("pack seg label:", page.text_content("#tseg .chip[data-v=pack]")); print("packing:", rows)
        page.click(".pack-row:has-text('Jeans') input"); page.click(".pack-row:has-text('Sneakers') input")
        print("progress:", page.text_content("#tbody strong"))
        page.click("#addExtra"); page.wait_for_selector(".sheet"); print("extra choices:", page.eval_on_selector_all(".sheet .card .meta span", "e => e.map(x => x.textContent)"))
        page.click(".sheet .card:has-text('Scarf')"); page.click(".sheet [data-close]")
        print("after extra:", page.text_content("#tbody strong"), "|", page.inner_text(".pack-row:has-text('Scarf')").replace("\n", " "))
        page.screenshot(path="/tmp/wardrobe-shots/91-pack.png", full_page=True)
        page.click(".pack-row:has-text('Scarf') .x"); print("extra removed:", page.text_content("#tbody strong"))
        page.click("#tseg .chip[data-v=more]"); page.wait_for_selector(".panel")
        print("possible:", page.eval_on_selector_all("#tbody .planned .pl-name", "e => e.map(x => x.textContent)"), "|", page.text_content(".panel p"))
        page.screenshot(path="/tmp/wardrobe-shots/92-more.png", full_page=True)
        page.click("#tbody [data-plan]"); page.wait_for_selector(".sheet"); page.click(".sheet .pick >> nth=2"); page.wait_for_selector(".sheet", state="detached")
        print("after planning Cosy on day 3, possible:", page.eval_on_selector_all("#tbody .planned .pl-name", "e => e.map(x => x.textContent)") or "none")
        page.click("text=Try combinations"); page.wait_for_selector(".carousel")
        rows = page.eval_on_selector_all(".carousel", "e => e.map(c => c.dataset.layer + ':' + [...c.querySelectorAll('img')].map(i => i.alt).join(','))")
        print("mix rows (packed only):", rows, "| back:", page.text_content(".topbar .back"))
        page.fill("#oname", "Mixed"); page.click("#osave"); page.wait_for_selector("#tname")
        print("after save back on:", page.evaluate("location.hash"), "| outfits possible:", page.eval_on_selector_all("#tbody .planned .pl-name", "e => e.map(x => x.textContent)"))
        page.click("#tseg .chip[data-v=plan]"); page.fill("#tend", "2026-11-06"); page.dispatch_event("#tend", "change")
        page.click("#tseg .chip[data-v=pack]"); page.wait_for_selector(".pack-row")
        print("2 days -> sneakers:", page.inner_text(".pack-row:has-text('Sneakers') small"), "| label:", page.text_content("#tseg .chip[data-v=pack]"))
        page.reload(); page.wait_for_selector("#tname")
        print("after reload: name", page.input_value("#tname"), "| dates", page.input_value("#tstart"), page.input_value("#tend"), "| packed:", page.text_content("#tbody strong") if page.query_selector(".pack-row") else page.text_content("#tseg"))
        page.goto("http://localhost:8765/#/outfit/o2"); page.wait_for_selector("#odel"); page.click("#odel"); page.wait_for_selector(".outfit")
        page.goto("http://localhost:8765/#/trips"); page.wait_for_selector(".outfit"); print("trip card:", page.inner_text(".outfit").replace("\n", " "))
        page.click(".outfit"); page.click("#tseg .chip[data-v=plan]")
        print("day 2 after deleting 'Skirt day':", page.eval_on_selector_all(".day >> nth=1 >> .planned .pl-name", "e => e.map(x => x.textContent)"))
        page.goto("http://localhost:8765/#/settings"); page.wait_for_selector("#exp")
        with page.expect_download() as dl: page.click("#exp")
        data = json.load(open(dl.value.path())); print("backup: version", data["version"], "| trips:", [t["name"] for t in data["trips"]])
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console warnings/errors")
