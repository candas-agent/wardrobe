import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys, json
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def shot(page, name): page.screenshot(path=f"/tmp/wardrobe-shots/{name}.png")
SEED = """async () => {
  const db = await import('/db.js');
  for (const s of ['items', 'outfits', 'settings']) await db.clear(s);
  const get = async u => (await fetch(u)).blob();
  const add = async (id, type, colour, name, withCutout) => db.put('items', { id, createdAt: Date.now() + id.length, type, colour, colour2: '', name: '', notes: '',
    photo: await get(`/testasset/${name}_white.jpg`), thumb: await get(`/testasset/${name}_white.jpg`), original: null, source: null,
    cutout: withCutout ? await get(`/testasset/${name}.png`) : null, fit: null });
  await add('i1', 'jumper', 'black', 'sweater', true);
  await add('i2', 'jeans', 'navy', 'jeans', true);
  await add('i3', 'sneakers', 'black', 'shoe', true);
  await add('i4', 'jacket', 'navy', 'jacket', false); // old-style item: white background only
  await add('i5x', 'sneakers', 'black', 'pair_touching', true);
  await add('i5', 'sneakers', 'black', 'pair', true); // newest, so the builder starts with it
  await db.put('outfits', { id: 'o-old', name: 'Old outfit', createdAt: 1, itemIds: ['i1', 'i2', 'i3'] }); // saved before pictures existed
}"""
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(_SCRATCH + "/pw-profile", args=["--ignore-certificate-errors"],
            viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.route("**/testasset/*", lambda r: r.fulfill(path="/tmp/pd/" + r.request.url.split("/")[-1]))
        page = ctx.new_page(); page.on("framenavigated", lambda f: f == page.main_frame and print(f"  [nav {time.strftime('%X')}] {f.url}", flush=True))
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}")); page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        page.reload(); page.wait_for_timeout(1500)  # new version via the service worker
        page.evaluate(SEED)
        page.goto("http://localhost:8765/#/outfit/new"); page.wait_for_selector("#layerToggles")
        page.click("#layerToggles [data-v=me]"); page.wait_for_selector(".onme .empty"); print("no photo:", page.text_content(".onme").strip()[:60])
        page.click(".onme-close"); print("closed:", page.query_selector(".onme") is None)
        page.goto("http://localhost:8765/#/settings"); page.wait_for_selector("#mePhoto", state="attached")
        t = time.time(); page.set_input_files("#mePhoto", _SCRATCH + "/dl-pose/person.jpg")
        page.wait_for_selector(".me-thumb", timeout=600000); print(f"photo set in {time.time() - t:.1f}s")
        page.goto("http://localhost:8765/#/outfit/new"); page.wait_for_selector("#layerToggles")
        page.click("#layerToggles [data-v=outer]"); page.wait_for_timeout(300)
        page.click("#layerToggles [data-v=me]"); page.wait_for_selector(".onme .worn"); page.wait_for_timeout(800)
        print("fullscreen api:", page.evaluate("!!document.fullscreenElement"), "| overlay covers tabs:", page.evaluate("document.elementFromPoint(200, 820).closest('.onme') !== null"))
        shot(page, "60-onme-fullscreen")
        r = page.eval_on_selector(".doll", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }"); print("doll box:", [round(v) for v in r])
        x, y = r[0] + r[2] * 0.62, r[1] + r[3] * 0.32
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 25, y + 15, steps=5); page.mouse.up(); page.wait_for_timeout(500)
        print("fits after drag:", page.evaluate("async () => { const db = await import('/db.js'); return (await db.getAll('items')).filter(i => i.fit).map(i => [i.id, i.fit]) }"))
        page.click(".onme-close"); page.wait_for_timeout(300); print("closed:", page.query_selector(".onme") is None, "| fullscreen:", page.evaluate("!!document.fullscreenElement"))
        page.fill("#oname", "Test outfit"); page.click("#osave"); page.wait_for_selector(".outfit"); page.wait_for_timeout(300)
        page.wait_for_function("[...document.querySelectorAll('.onme-pic')].every(i => !i.hidden && i.complete && i.naturalWidth)", timeout=60000)
        print("list pictures:", page.evaluate("[...document.querySelectorAll('.outfit')].map(o => [o.querySelector('strong').textContent, o.querySelector('.onme-pic').naturalWidth + 'x' + o.querySelector('.onme-pic').naturalHeight])"))
        shot(page, "61-outfits-list")
        page.goto("http://localhost:8765/#/outfit/o-old"); page.wait_for_selector("#layerToggles"); page.goto("http://localhost:8765/#/outfits"); page.wait_for_selector(".outfit"); page.wait_for_timeout(1500)
        sigs = page.evaluate("async () => { const db = await import('/db.js'); return (await db.getAll('outfits')).map(o => [o.name, o.preview?.sig.slice(0, 30)]) }"); print("sigs:", sigs)
        ctx.close()
finally:
    srv.terminate(); print("\n".join(l for l in logs if "[log]" not in l) or "no console warnings/errors")
