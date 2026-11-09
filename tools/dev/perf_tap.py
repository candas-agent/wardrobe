import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys, json
from playwright.sync_api import sync_playwright
PORT = sys.argv[1] if len(sys.argv) > 1 else "8765"
srv = subprocess.Popen([sys.executable, "-m", "http.server", PORT, "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
def tap(page, x, y):
    r = page.eval_on_selector("#stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }")
    page.mouse.click(r[0] + x / 1200 * r[2], r[1] + y / 900 * r[3])
OUTLINE = "(n) => document.querySelectorAll('#cands .cand').length && window.__outlines >= n"
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.goto(f"http://localhost:{PORT}/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        page.reload(); page.wait_for_selector(".topbar"); print("isolated:", page.evaluate("crossOriginIsolated"))
        cdp = ctx.new_cdp_session(page); cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})  # ~mid-range phone
        # count outline renders: wrap the candidate container updates
        page.add_init_script("")
        def fresh_photo():
            page.goto(f"http://localhost:{PORT}/#/"); page.wait_for_selector(".add-files", state="attached")
            page.evaluate("""() => { window.__outlines = 0; new MutationObserver(() => {
              if (document.querySelectorAll('#cands .cand').length) window.__outlines++; }).observe(document.body, { childList: true, subtree: true }); }""")
            page.set_input_files(".add-files >> nth=0", ["/tmp/flatlay.jpg"]); page.wait_for_selector("#stage", timeout=120000)
            page.evaluate("""() => { window.__outlines = 0; new MutationObserver(m => {
              if (m.some(r => r.target.id === 'cands' && r.addedNodes.length)) window.__outlines++; }).observe(document.getElementById('cands'), { childList: true }); }""")
        # A: tap right away after the photo appears
        fresh_photo(); t0 = time.time(); tap(page, 224, 295)
        page.wait_for_function(OUTLINE, arg=1, timeout=120000); a = time.time() - t0
        page.wait_for_function("!document.querySelector('#typeSuggest .status')", timeout=120000); a_type = time.time() - t0
        # B: tap after everything is idle
        fresh_photo(); page.wait_for_function("document.querySelector('#typeSuggest .chip') && !document.querySelector('#typeSuggest .status')", timeout=120000); page.wait_for_timeout(8000)
        t0 = time.time(); tap(page, 224, 295); page.wait_for_function(OUTLINE, arg=1, timeout=120000); bt = time.time() - t0
        # C: second tap while the first tap's type re-detection is still running
        page.wait_for_function("!document.querySelector('#typeSuggest .status')", timeout=120000)
        tap(page, 595, 285); page.wait_for_timeout(150)  # outline arrives, re-detection starts
        t0 = time.time(); tap(page, 985, 662); page.wait_for_function(OUTLINE, arg=3, timeout=120000); c = time.time() - t0
        print(f"A tap right after photo loads : outline {a:.1f}s (type updated {a_type:.1f}s)")
        print(f"B tap when idle               : outline {bt:.2f}s")
        print(f"C tap during re-detection     : outline {c:.2f}s")
        b.close()
finally:
    srv.terminate()
