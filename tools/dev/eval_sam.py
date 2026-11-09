import io, random, time, numpy as np, pyarrow.parquet as pq
from PIL import Image, ImageFilter
from scipy import ndimage
exec(open("compare_sam.py").read().split("# test images")[0])
from huggingface_hub import hf_hub_download
p = hf_hub_download("ashraq/fashion-product-images-small", "data/train-00001-of-00002-bb459e5ac5f01e71.parquet", repo_type="dataset")
FLAT = ["Casual Shoes", "Sports Shoes", "Handbags", "Backpacks", "Caps", "Belts", "Wallets", "Flip Flops", "Sandals", "Heels", "Formal Shoes", "Clutches"]
rows = [r for r in pq.read_table(p, columns=["articleType", "image"]).to_pylist() if r["articleType"] in FLAT]
models = [("SlimSAM (current)", slimsam), ("EdgeSAM-3x", edgesam), ("MobileSAM", mobilesam)]
random.seed(5); rng = np.random.default_rng(5)
res = {m: {"best": [], "top": []} for m, _ in models}; times = {m: [] for m, _ in models}
for scene in range(15):
    bg = (np.array(rng.integers(90, 200, 3)) + rng.normal(0, 14, (900, 1200, 1)) + 18*np.sin(np.arange(1200)/(6+scene))[None, :, None]).clip(0, 255).astype("uint8")
    img = Image.fromarray(bg); gts = []
    for k, x in enumerate([40, 430, 820]):
        r = random.choice(rows); it = Image.open(io.BytesIO(r["image"]["bytes"])).convert("RGB").resize((330, 440), Image.LANCZOS)
        m = Image.fromarray(((np.abs(np.asarray(it).astype(int) - 255).sum(2) > 45) * 255).astype("uint8")).filter(ImageFilter.MedianFilter(5))
        m = Image.fromarray((ndimage.binary_fill_holes(np.asarray(m) > 0) * 255).astype("uint8"))
        y = int(rng.integers(40, 420)); img.paste(it, (x, y), m)
        g = np.zeros((900, 1200), bool); g[y:y+440, x:x+330] = np.asarray(m) > 0
        inner = ndimage.binary_erosion(g, iterations=12)
        if inner.sum() < 50: continue
        ys, xs = np.nonzero(inner); i = rng.integers(len(xs)); gts.append((g, (int(xs[i]), int(ys[i]))))
    for g, pt in gts:
        for mname, fn in models:
            cands = fn(img, pt)
            ious = [float((m & g).sum() / max(1, (m | g).sum())) for m, _ in cands]
            res[mname]["best"].append(max(ious)); res[mname]["top"].append(ious[int(np.argmax([s for _, s in cands]))])
n = len(res[models[0][0]]["best"])
print(f"{n} taps on product photos composited on textured backgrounds (IoU with the true shape, 1 = perfect)")
for mname, _ in models:
    b, t = np.array(res[mname]["best"]), np.array(res[mname]["top"])
    print(f"{mname:18s} best outline offered: mean {b.mean():.3f}, >=0.9 for {np.mean(b >= .9):.0%} | default (top score): mean {t.mean():.3f}, >=0.9 for {np.mean(t >= .9):.0%}")
