import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []; S = "/tmp/wardrobe-samples/"
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--ignore-certificate-errors"])
        page = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}")); page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.goto("http://localhost:8765/"); page.wait_for_selector(".topbar")
        print("default:", repr(page.text_content(".topbar .title")), "| tabs:", page.eval_on_selector_all(".tabs a", "e => e.map(x => x.textContent.trim())"),
              "| active:", page.eval_on_selector(".tabs a.active", "e => e.dataset.tab"))
        page.screenshot(path="/tmp/wardrobe-shots/80-empty.png")
        page.set_input_files("#addFirst", [S + "Dresses.jpg"]); page.wait_for_selector("#stage")
        print("after picking 1:", page.evaluate("location.hash"), "| active tab:", page.eval_on_selector(".tabs a.active", "e => e.dataset.tab"))
        page.click("#save"); page.wait_for_selector("#grid .card"); print("after save:", page.evaluate("location.hash"), "| title:", repr(page.text_content(".topbar .title")))
        page.set_input_files("#addFiles", [S + "Jeans.jpg", S + "Skirts.jpg", S + "Sweaters.jpg", S + "Casual_Shoes.jpg"]); page.wait_for_selector("#stage")
        print("batch:", page.text_content(".topbar .title"))
        page.go_back(); page.wait_for_selector("#grid .card"); print("back during batch ->", page.evaluate("location.hash"), "| items:", page.evaluate("document.querySelectorAll('#grid .card').length"))
        page.set_input_files("#addFiles", [S + "Jeans.jpg", S + "Skirts.jpg", S + "Sweaters.jpg", S + "Casual_Shoes.jpg"])
        for i in range(4):
            page.wait_for_function(f"document.querySelector('.topbar .title')?.textContent.includes('{i+1} of 4')"); page.click("#save")
        page.wait_for_selector("#grid .card"); page.wait_for_timeout(300)
        print("batch saved ->", page.evaluate("location.hash"), "| title:", repr(page.text_content(".topbar .title")))
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)"); page.wait_for_timeout(300)
        print("Add button top after scroll:", round(page.eval_on_selector("#addFiles", "e => e.parentElement.getBoundingClientRect().top")), "px | scrollY", page.evaluate("Math.round(scrollY)"))
        page.screenshot(path="/tmp/wardrobe-shots/81-wardrobe.png")
        page.goto("http://localhost:8765/#/add"); page.wait_for_timeout(500); print("open #/add directly ->", page.evaluate("location.hash"))
        b.close()
finally:
    srv.terminate(); print("\n".join(logs) or "no console warnings/errors")
