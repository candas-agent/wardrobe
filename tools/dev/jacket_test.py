import numpy as np
from PIL import Image, ImageDraw
exec(open("compare_sam.py").read().split("# test images")[0])
img = Image.open("/tmp/jacket.png").convert("RGB"); W, H = img.size
a, s, nw, nh = resized(img)
x = np.zeros((1, 3, 1024, 1024), np.float32); x[0, :, :nh, :nw] = ((a - [123.675, 116.28, 103.53]) / [58.395, 57.12, 57.375]).transpose(2, 0, 1)
emb, = edge_e.run(None, {"image": x})
def decode(points):
    sc, m = edge_d.run(None, {"image_embeddings": emb, "point_coords": np.array([[[px*s, py*s] for px, py in points]], np.float32),
                              "point_labels": np.ones((1, len(points)), np.float32)})
    return [(lowres_to_full(m[0, k], nw, nh, W, H), float(sc[0, k])) for k in range(m.shape[1])]
L, R = (120, 380), (430, 380)
rows = [("tap left half", decode([L]), [L]), ("tap right half", decode([R]), [R]), ("both points together", decode([L, R]), [L, R])]
union = [(decode([L])[i][0] | decode([R])[j][0], 0) for i, j in [(0, 0), (1, 1), (2, 2), (3, 3)]]
best_l = max(decode([L]), key=lambda t: t[1])[0]; best_r = max(decode([R]), key=lambda t: t[1])[0]
rows.append(("merge of best L + best R", [(best_l | best_r, 0)], [L, R]))
T = 200
sheet = Image.new("RGB", (190 + 4 * (T + 8), len(rows) * (T + 22) + 6), "white"); d = ImageDraw.Draw(sheet)
for r, (name, cands, pts) in enumerate(rows):
    d.text((5, r * (T + 22) + T // 2), name, fill="black")
    for k, (mask, sc) in enumerate(cands):
        vis = Image.composite(img, Image.blend(img, Image.new("RGB", img.size, "black"), 0.7), Image.fromarray((mask * 255).astype(np.uint8)))
        dd = ImageDraw.Draw(vis)
        for px, py in pts: dd.ellipse([px-9, py-9, px+9, py+9], fill="lime", outline="white", width=3)
        vis.thumbnail((T, T)); x0, y0 = 190 + k * (T + 8), r * (T + 22) + 4
        sheet.paste(vis, (x0, y0)); d.text((x0, y0 + T + 2), f"#{k} score {sc:.2f}" if sc else "merged", fill="black")
sheet.save("/tmp/jacket_test.png"); print("ok")
cands = decode([L, R])
sheet = Image.new("RGB", (4 * 290, 400), "white"); d = ImageDraw.Draw(sheet)
for k, (mask, sc) in enumerate(cands):
    tint = Image.blend(img, Image.new("RGB", img.size, (255, 40, 40)), 0.55)
    vis = Image.composite(tint, img, Image.fromarray((mask * 255).astype(np.uint8))); vis.thumbnail((280, 370))
    sheet.paste(vis, (k * 290, 0)); d.text((k * 290 + 4, 380), f"both points #{k} score {sc:.2f} area {mask.mean():.0%}", fill="black")
sheet.save("/tmp/jacket_tint.png")
