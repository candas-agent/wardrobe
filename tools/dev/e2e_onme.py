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
}"""
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(_SCRATCH + "/pw-profile", args=["--ignore-certificate-errors"],
            viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.route("**/testasset/*", lambda r: r.fulfill(path="/tmp/pd/" + r.request.url.split("/")[-1]))
        page = ctx.new_page()
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}")); page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        page.reload(); page.wait_for_timeout(1500)  # new version via the service worker
        page.evaluate(SEED)
        page.goto("http://localhost:8765/#/outfit/new"); page.wait_for_selector("#layerToggles")
        page.click("#layerToggles [data-v=me]"); page.wait_for_selector("#dollBox .empty"); print("no photo:", page.text_content("#dollBox").strip()[:80])
        page.goto("http://localhost:8765/#/settings"); page.wait_for_selector("#mePhoto", state="attached")
        t = time.time(); page.set_input_files("#mePhoto", _SCRATCH + "/dl-pose/person.jpg")
        last = None
        for _ in range(120):
            if page.query_selector(".me-thumb"): break
            st = page.text_content("#meStatus")
            if st != last: print(f"  {time.time() - t:5.0f}s status: {st}", flush=True); last = st
            page.wait_for_timeout(5000)
        page.wait_for_selector(".me-thumb", timeout=1000); print(f"photo set in {time.time() - t:.1f}s; status:", repr(page.text_content("#meStatus")))
        shot(page, "50-settings-me")
        pose = page.evaluate("async () => { const db = await import('/db.js'); const m = await db.get('settings', 'me'); return { ok: m.pose.ok, W: m.pose.W, H: m.pose.H, k: m.pose.kpts.map(p => [Math.round(p.x), Math.round(p.y), +p.score.toFixed(2)]) } }")
        print("pose:", pose["ok"], pose["W"], pose["H"], pose["k"][5:7], pose["k"][11:13], pose["k"][15:17])
        page.goto("http://localhost:8765/#/outfit/new"); page.wait_for_selector("#layerToggles")
        if not page.query_selector("#layerToggles [data-v=me].on"): page.click("#layerToggles [data-v=me]")
        page.click("#layerToggles [data-v=outer]"); page.wait_for_selector(".doll .worn"); page.wait_for_timeout(500)
        print("worn images:", page.evaluate("document.querySelectorAll('.doll .worn').length"))
        shot(page, "51-onme")
        # drag the jacket (old-style item) a bit to the right and down
        r = page.eval_on_selector(".doll", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
        x, y = r[0] + r[2] * 0.62, r[1] + r[3] * 0.3
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 30, y + 20, steps=5); page.mouse.up(); page.wait_for_timeout(500)
        fits = page.evaluate("async () => { const db = await import('/db.js'); return (await db.getAll('items')).map(i => [i.id, i.fit]) }"); print("fits after drag:", fits)
        shot(page, "52-dragged")
        page.mouse.click(x + 30, y + 20); page.wait_for_timeout(100); page.mouse.click(x + 30, y + 20); page.wait_for_timeout(500)
        fits = page.evaluate("async () => { const db = await import('/db.js'); return (await db.getAll('items')).map(i => [i.id, i.fit]) }"); print("fits after double-tap:", fits)
        ctx.close()
finally:
    srv.terminate(); print("\n".join(l for l in logs if "[log]" not in l) or "no console warnings/errors")
