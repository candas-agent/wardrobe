import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
# Single shoes: toes point outwards whichever way the shoe was photographed; hold swaps; double-tap keeps the swap.
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
SEED = """async () => {
  const db = await import('/db.js');
  for (const s of ['items', 'outfits']) await db.clear(s);
  const sneaker = async mirror => { // side view: tall collar at the heel, low toe
    const c = new OffscreenCanvas(340, 180), x = c.getContext('2d');
    if (mirror) { x.translate(340, 0); x.scale(-1, 1); }
    x.fillStyle = '#222'; x.beginPath();
    x.moveTo(10, 170); x.lineTo(10, 30); x.lineTo(60, 15); x.lineTo(130, 40); x.lineTo(210, 85); x.lineTo(300, 110); x.quadraticCurveTo(338, 125, 335, 170); x.closePath(); x.fill();
    return c.convertToBlob({ type: 'image/png' });
  };
  const topView = async () => { const c = new OffscreenCanvas(160, 400), x = c.getContext('2d'); x.fillStyle = '#222'; x.beginPath(); x.ellipse(80, 200, 70, 190, 0, 0, 7); x.fill(); return c.convertToBlob({ type: 'image/png' }); };
  const add = (id, blob, t) => db.put('items', { id, createdAt: t, type: 'sneakers', colour: 'black', colour2: '', name: id, notes: '', photo: blob, thumb: blob, original: null, source: null, cutout: blob, fit: null });
  await add('toeRight', await sneaker(false), 3); await add('toeLeft', await sneaker(true), 2); await add('top', await topView(), 1);
}"""
ART = """async id => { const db = await import('/db.js'), d = await import('/doll.js'); return (await d.itemArt(await db.get('items', id))).toe; }"""
FEET = """() => [...document.querySelectorAll('.onme .worn')].map(e => ({ left: parseFloat(e.style.left), mirrored: e.style.transform.includes('-1') }))
  .sort((a, b) => a.left - b.left).map(f => f.mirrored ? 'mirrored' : 'as photographed')"""
def onme(page, item_id):
    page.evaluate(f"async () => {{ const db = await import('/db.js'); await db.put('outfits', {{ id: 'o', name: 'o', createdAt: 1, itemIds: ['{item_id}'] }}); }}")
    page.goto("http://localhost:8765/#/outfits"); page.goto("http://localhost:8765/#/outfit/o"); page.wait_for_selector("#layerToggles")
    page.click("#layerToggles [data-v=me]"); page.wait_for_selector(".onme .worn"); page.wait_for_timeout(500)
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(_SCRATCH + "/pw-profile", args=["--ignore-certificate-errors"], viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page(); page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}")); page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000); page.reload(); page.wait_for_timeout(1500)
        page.evaluate(SEED)
        if not page.evaluate("async () => !!(await (await import('/db.js')).get('settings', 'me'))"):
            page.goto("http://localhost:8765/#/settings"); page.set_input_files("#mePhoto", _SCRATCH + "/dl-pose/person.jpg")
            page.wait_for_selector(".stage.crop"); page.click("#next"); page.wait_for_selector("#save:not([disabled])", timeout=600000); page.click("#save"); page.wait_for_selector(".me-thumb")
        for i in ['toeRight', 'toeLeft', 'top']: print(f"{i}: detected toe = {page.evaluate(ART, i)}")
        # the foot on the left of the photo must show the shoe with its toe pointing left
        onme(page, 'toeRight'); print("toeRight feet (left, right):", page.evaluate(FEET), "-> expect mirrored, as photographed")
        print("hint:", page.text_content(".onme-hint"))
        onme(page, 'toeLeft'); print("toeLeft feet (left, right):", page.evaluate(FEET), "-> expect as photographed, mirrored")
        page.screenshot(path="/tmp/wardrobe-shots/80-toeleft.png")
        # hold a shoe to swap
        b = page.eval_on_selector(".onme .worn", "e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height * 0.7] }")
        page.mouse.move(*b); page.mouse.down(); page.wait_for_timeout(700); page.mouse.up(); page.wait_for_timeout(400)
        print("after hold:", page.evaluate(FEET), "| fit:", page.evaluate("async () => (await (await import('/db.js')).get('items', 'toeLeft')).fit"))
        page.screenshot(path="/tmp/wardrobe-shots/81-swapped.png")
        page.mouse.click(*b); page.wait_for_timeout(120); page.mouse.click(*b); page.wait_for_timeout(400)
        print("after double-tap:", page.evaluate(FEET), "| fit:", page.evaluate("async () => (await (await import('/db.js')).get('items', 'toeLeft')).fit"))
        page.click(".onme-close")
        onme(page, 'toeLeft'); print("reopened:", page.evaluate(FEET))
        ctx.close()
finally:
    srv.terminate(); print("\n".join(l for l in logs if "[log]" not in l and "No available" not in l) or "no console warnings/errors")
