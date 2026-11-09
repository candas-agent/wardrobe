import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
# Your photo: crop, background removal with tap corrections, save, On me / outfit picture, edit again, keep background.
import subprocess, time, sys, json
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def shot(page, name): page.screenshot(path=f"/tmp/wardrobe-shots/{name}.png")
SEED = """async () => {
  const db = await import('/db.js');
  for (const s of ['items', 'outfits', 'settings']) await db.clear(s);
  const shape = async (draw, w, h, colour) => { const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); x.fillStyle = colour; draw(x); return c.convertToBlob({ type: 'image/png' }); };
  const top = await shape(x => { x.beginPath(); x.moveTo(90, 0); x.lineTo(210, 0); x.lineTo(300, 60); x.lineTo(270, 140); x.lineTo(240, 110); x.lineTo(240, 300); x.lineTo(60, 300); x.lineTo(60, 110); x.lineTo(30, 140); x.lineTo(0, 60); x.closePath(); x.fill(); }, 300, 300, '#a33');
  const jeans = await shape(x => { x.fillRect(0, 0, 200, 60); x.fillRect(0, 0, 90, 500); x.fillRect(110, 0, 90, 500); }, 200, 500, '#36c');
  const add = (id, type, blob) => db.put('items', { id, createdAt: Date.now() + id.length, type, colour: 'red', colour2: '', name: '', notes: '', photo: blob, thumb: blob, original: null, source: null, cutout: blob, fit: null });
  await add('t1', 'jumper', top); await add('b1', 'jeans', jeans);
  await db.put('outfits', { id: 'o1', name: 'Test', createdAt: 1, itemIds: ['t1', 'b1'] });
}"""
ME = "async () => { const db = await import('/db.js'); const m = await db.get('settings', 'me'); return m && { crop: m.crop, points: m.points?.length, excl: m.points?.filter(p => !p.include).length, removeBg: m.removeBg, cutout: m.cutout?.type ?? null, photo: m.photo.type, original: m.original?.size, W: m.pose.W, H: m.pose.H, ok: m.pose.ok } }"
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(_SCRATCH + "/pw-profile", args=["--ignore-certificate-errors"], viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}")); page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        page.reload(); page.wait_for_timeout(1500)
        page.evaluate(SEED)
        page.goto("http://localhost:8765/#/settings"); page.wait_for_selector("#mePhoto", state="attached")
        page.set_input_files("#mePhoto", _SCRATCH + "/dl-pose/person.jpg")
        page.wait_for_selector(".stage.crop"); page.wait_for_timeout(400); shot(page, "70-crop-start")
        r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
        # drag top-left corner in to cut off the card border, bottom-right corner likewise
        def drag(x0, y0, x1, y1):
            page.mouse.move(x0, y0); page.mouse.down(); page.mouse.move(x1, y1, steps=6); page.mouse.up()
        drag(r[0] - 6, r[1] - 6, r[0] + r[2] * 0.10, r[1] + r[3] * 0.06)  # starts just outside the photo
        drag(r[0] + r[2] + 6, r[1] + r[3] + 6, r[0] + r[2] * 0.90, r[1] + r[3] * 0.94)
        drag(r[0] + r[2] * 0.5, r[1] + r[3] * 0.5, r[0] + r[2] * 0.5 + 500, r[1] + r[3] * 0.5)  # move: clamps at the right edge
        drag(r[0] + r[2] * 0.95, r[1] + r[3] * 0.5, r[0] + r[2] * 0.95 - 5, r[1] + r[3] * 0.5)  # nudge so the move is visible
        shot(page, "71-crop-done")
        r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
        page.click("#next"); page.wait_for_timeout(300); page.click("#back"); page.wait_for_selector(".stage.crop"); print("back while working: crop step")
        t = time.time(); page.click("#next")
        page.wait_for_function("!document.querySelector('#save').disabled || /Couldn/.test(document.querySelector('#bgStatus').textContent)", timeout=300000); print(f"background ready in {time.time() - t:.1f}s:", page.text_content("#bgStatus"))
        shot(page, "72-bg-auto")
        # tap the chair seat (left, below the hand) to take it away if it's in
        r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
        page.mouse.click(r[0] + r[2] * 0.12, r[1] + r[3] * 0.55); page.wait_for_timeout(2500); shot(page, "73-bg-added")  # outside: adds the chair
        PTS = "() => [...document.querySelectorAll('#bgStatus')].length && window.__pts?.()"
        page.mouse.click(r[0] + r[2] * 0.12, r[1] + r[3] * 0.55); page.wait_for_timeout(2500); shot(page, "73-bg-undone")  # the dot: undo
        page.mouse.click(r[0] + r[2] * 0.40, r[1] + r[3] * 0.35); page.wait_for_timeout(2500); shot(page, "73-bg-tapped")  # on the jacket (inside): take away
        page.click("#save"); page.wait_for_selector(".me-thumb", timeout=60000); page.wait_for_timeout(500)
        print("saved (expect 1 exclusion):", page.evaluate(ME))
        page.click("a[href='#/me']"); page.wait_for_selector(".stage.crop"); page.click("#next"); page.wait_for_selector("#save:not([disabled])", timeout=600000)
        page.mouse.click(r[0] + r[2] * 0.40, r[1] + r[3] * 0.35); page.wait_for_timeout(2500)  # the red dot: undo
        page.click("#save"); page.wait_for_selector(".me-thumb", timeout=60000); page.wait_for_timeout(500)
        print("saved (expect 0 exclusions):", page.evaluate(ME)); shot(page, "74-settings")
        page.goto("http://localhost:8765/#/outfit/o1"); page.wait_for_selector("#layerToggles"); page.click("#layerToggles [data-v=me]")
        page.wait_for_selector(".onme .worn"); page.wait_for_timeout(800); shot(page, "75-onme")
        print("doll cut class:", page.evaluate("document.querySelector('.doll').classList.contains('cut')"))
        page.click(".onme-close")
        page.goto("http://localhost:8765/#/outfits"); page.wait_for_function("[...document.querySelectorAll('.onme-pic')].every(i => !i.hidden && i.complete && i.naturalWidth)", timeout=60000)
        page.wait_for_timeout(300); shot(page, "76-outfits")
        # edit again: crop and corrections come back
        page.goto("http://localhost:8765/#/settings"); page.click("a[href='#/me']"); page.wait_for_selector(".stage.crop"); page.wait_for_timeout(300)
        page.click("#next"); page.wait_for_selector("#save:not([disabled])", timeout=600000)
        print("re-edit points shown:", page.evaluate("document.querySelector('#bgStatus').textContent"))
        page.uncheck("#removeBg"); page.wait_for_timeout(200); shot(page, "77-keep-bg")
        page.click("#save"); page.wait_for_selector(".me-thumb"); page.wait_for_timeout(300)
        print("saved without removal:", page.evaluate(ME))
        # reload on #/me without a picked file goes on editing the saved photo; without any photo: back to settings
        page.goto("http://localhost:8765/#/me"); page.wait_for_selector(".stage.crop"); print("reload on #/me: editor")
        ctx.close()
finally:
    srv.terminate(); print("\n".join(l for l in logs if "[log]" not in l) or "no console warnings/errors")
