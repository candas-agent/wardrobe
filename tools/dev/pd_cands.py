exec(open("paperdoll.py").read().split('if __name__')[0])
from PIL import ImageDraw
tiles = []
for name, path, pts in [("sweater", "/tmp/flatlay.jpg", [(590, 300)]), ("jeans", "/tmp/flatlay.jpg", [(215, 330)]), ("shoe", "/tmp/flatlay.jpg", [(985, 660)])]:
    for k in range(4):
        c = cut(path, pts, k); bg = Image.new("RGBA", c.size, (120, 160, 120, 255)); bg.alpha_composite(c)
        bg.thumbnail((160, 200)); t = Image.new("RGB", (170, 220), "white"); t.paste(bg.convert("RGB"), (5, 0))
        ImageDraw.Draw(t).text((5, 205), f"{name} #{k}", fill="black"); tiles.append(t)
s = Image.new("RGB", (4 * 170, 3 * 220), "white")
for i, t in enumerate(tiles): s.paste(t, ((i % 4) * 170, (i // 4) * 220))
s.save("/tmp/pd_cands.png")
