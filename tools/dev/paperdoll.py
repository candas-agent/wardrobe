import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
# Paper-doll prototype: place item cut-outs onto a full-body photo using body landmarks.
import sys, numpy as np
from PIL import Image, ImageDraw, ImageOps
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
exec(open("compare_sam.py").read().split("# test images")[0])

def cut(path, points, pick=None):
    img = Image.open(path).convert("RGB"); W, H = img.size
    a, s, nw, nh = resized(img)
    x = np.zeros((1, 3, 1024, 1024), np.float32); x[0, :, :nh, :nw] = ((a - [123.675, 116.28, 103.53]) / [58.395, 57.12, 57.375]).transpose(2, 0, 1)
    emb, = edge_e.run(None, {"image": x})
    sc, m = edge_d.run(None, {"image_embeddings": emb, "point_coords": np.array([[[px*s, py*s] for px, py in points]], np.float32),
                              "point_labels": np.ones((1, len(points)), np.float32)})
    k = pick if pick is not None else (0 if len(points) > 1 else int(np.argmax(sc[0])))
    mask = Image.fromarray((lowres_to_full(m[0, k], nw, nh, W, H) * 255).astype(np.uint8))
    rgba = img.convert("RGBA"); rgba.putalpha(mask)
    return rgba.crop(mask.getbbox())

def pose(path):
    lm = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=_SCRATCH + "/dl-pose/pose_landmarker_lite.task")))
    img = mp.Image.create_from_file(path)
    p = lm.detect(img).pose_landmarks[0]
    return {i: np.array([q.x * img.width, q.y * img.height]) for i, q in enumerate(p)}

def row_width(item, f):  # opaque extent of the row at fraction f of the height
    a = np.asarray(item.getchannel("A")); r = a[min(a.shape[0] - 1, int(f * a.shape[0]))] > 128
    xs = np.nonzero(r)[0]; return (xs[-1] - xs[0] + 1) if len(xs) else item.width

def place(canvas, item, width_at, f, target_w, anchor_x, anchor_y, mirror=False):
    k = target_w / row_width(item, f) if width_at else target_w / item.width
    it = item.resize((max(1, int(item.width * k)), max(1, int(item.height * k))), Image.LANCZOS)
    if mirror: it = ImageOps.mirror(it)
    canvas.alpha_composite(it, (int(anchor_x - it.width / 2), int(anchor_y - f * it.height)))

def dress(person_path, outfit):
    P = pose(person_path); base = Image.open(person_path).convert("RGBA")
    ls, rs, lh, rh = P[11], P[12], P[23], P[24]
    sw = np.linalg.norm(ls - rs); hw = np.linalg.norm(lh - rh)
    neck, hip = (ls + rs) / 2, (lh + rh) / 2
    out = base.copy()
    for kind, item in outfit:  # drawn in order: shoes, bottoms, top, outerwear
        if kind == "shoes":
            w = hw * 0.75
            for ankle, heel, toe, mirror in [(P[27], P[29], P[31], True), (P[28], P[30], P[32], False)]:
                bottom = max(heel[1], toe[1]) + 0.04 * w
                place(out, item, False, 1.0, w, ankle[0], bottom, mirror)
        elif kind == "bottom":  # trousers: waist at the hips, hem at the ankles, width from the hips
            top = hip[1] - 0.12 * (hip[1] - neck[1]); hem = (P[27][1] + P[28][1]) / 2 + 0.03 * (hip[1] - neck[1])
            kx = hw * 1.9 / row_width(item, 0.03)
            it = item.resize((int(item.width * kx), int(hem - top)), Image.LANCZOS)
            out.alpha_composite(it, (int(hip[0] - it.width / 2), int(top)))
        elif kind in ("top", "outer"):
            place(out, item, True, 0.15, sw * (1.35 if kind == "top" else 1.45), neck[0], neck[1])
    return out, P

if __name__ == "__main__":
    person = sys.argv[1]
    sweater = cut("/tmp/flatlay.jpg", [(590, 300)], 1)
    jeans = cut("/tmp/flatlay.jpg", [(198, 300), (252, 300), (222, 180)])
    shoe = cut("/tmp/flatlay.jpg", [(985, 660)], 3)
    jacket = cut("/tmp/jacket.png", [(120, 380), (430, 380)])
    a, P = dress(person, [("bottom", jeans), ("shoes", shoe), ("top", sweater)])
    b, _ = dress(person, [("bottom", jeans), ("shoes", shoe), ("top", sweater), ("outer", jacket)])
    src = Image.open(person).convert("RGBA"); d = ImageDraw.Draw(src)
    for i in (11, 12, 23, 24, 27, 28, 29, 30, 31, 32):
        x, y = P[i]; d.ellipse([x - 8, y - 8, x + 8, y + 8], fill="lime", outline="black")
    W, H = src.size; sheet = Image.new("RGB", (3 * W + 40, H), "white")
    for k, im in enumerate([src, a, b]): sheet.paste(im.convert("RGB"), (k * (W + 20), 0))
    sheet.thumbnail((1500, 1500)); sheet.save(sys.argv[2]); print("ok")
