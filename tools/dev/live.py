from playwright.sync_api import sync_playwright
logs = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--ignore-certificate-errors"])
    page = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True).new_page()
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}")); page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    page.goto("https://candas-agent.github.io/wardrobe/"); page.wait_for_selector("h1")
    print("title:", page.title(), "| h1:", page.text_content("h1"))
    page.wait_for_function("navigator.serviceWorker.controller || navigator.serviceWorker.ready", timeout=15000)
    print("manifest:", page.evaluate("fetch('manifest.webmanifest').then(r => r.status)"), "| sw:", page.evaluate("navigator.serviceWorker.ready.then(r => r.active?.scriptURL)"))
    page.goto("https://candas-agent.github.io/wardrobe/#/settings"); page.wait_for_selector("#dl")
    print("settings button:", page.text_content("#dl"))
    b.close()
print("\n".join(logs) or "no console output")
