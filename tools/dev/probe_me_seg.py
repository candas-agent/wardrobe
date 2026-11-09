import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
# Probe: EdgeSAM prompted with MoveNet keypoints, does it cut out the whole person? Saves masks as PNG.
import subprocess, time, sys, base64
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", _REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
JS = """async (variants) => {
  const doll = await import('/doll.js'), seg = await import('/segment.js'), { fit } = await import('/imaging.js');
  const bmp = await createImageBitmap(await (await fetch('/testasset/person.jpg')).blob());
  const work = fit(bmp, 1600);
  const pose = await doll.detectPose(work);
  const enc = await seg.encode(work);
  const names = ['nose','lEye','rEye','lEar','rEar','lSh','rSh','lEl','rEl','lWr','rWr','lHip','rHip','lKn','rKn','lAn','rAn'];
  const out = {};
  for (const [name, idx, centre] of variants) {
    const pts = idx.filter(i => pose.kpts[i].score > 0.3).map(i => ({ x: pose.kpts[i].x, y: pose.kpts[i].y, include: true }));
    if (centre) { const k = pose.kpts; pts.push({ x: (k[5].x + k[6].x + k[11].x + k[12].x) / 4, y: (k[5].y + k[6].y + k[11].y + k[12].y) / 4, include: true }); }
    const res = await seg.segment(enc, pts);
    const m = res.masks[res.best];
    const c = new OffscreenCanvas(work.width, work.height), ctx = c.getContext('2d');
    ctx.fillStyle = '#e6e6e9'; ctx.fillRect(0, 0, c.width, c.height);
    const cut = new OffscreenCanvas(work.width, work.height), cc = cut.getContext('2d');
    cc.drawImage(work, 0, 0); cc.globalCompositeOperation = 'destination-in'; cc.drawImage(m.canvas, 0, 0);
    ctx.drawImage(cut, 0, 0);
    ctx.fillStyle = '#e33'; for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.fill(); }
    const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    out[name] = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
  }
  return { out, scores: pose.kpts.map((p, i) => names[i] + ':' + p.score.toFixed(2)).join(' ') };
}"""
VARIANTS = [
  ["all", list(range(17)), False],
  ["core", [0, 5, 6, 11, 12, 13, 14, 15, 16], True],
  ["noarms", [0, 5, 6, 11, 12, 15, 16], True],
  ["centre", [], True],
]
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(_SCRATCH + "/pw-profile", args=["--ignore-certificate-errors"], viewport={"width": 390, "height": 844})
        ctx.route("**/testasset/*", lambda r: r.fulfill(path=_SCRATCH + "/dl-pose/" + r.request.url.split("/")[-1]))
        page = ctx.new_page(); page.on("pageerror", lambda e: print("[pageerror]", e))
        page.goto("http://localhost:8765/"); page.wait_for_selector("#modelBar[hidden]", state="attached", timeout=600000)
        r = page.evaluate(JS, VARIANTS)
        print(r["scores"])
        for k, v in r["out"].items():
            open(f"/tmp/wardrobe-shots/probe-{k}.jpg", "wb").write(base64.b64decode(v.split(",")[1]))
        ctx.close()
finally:
    srv.terminate()
