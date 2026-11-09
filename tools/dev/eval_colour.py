import sys, io, random, collections, numpy as np, pyarrow.parquet as pq
from PIL import Image
from huggingface_hub import hf_hub_download
p = hf_hub_download("ashraq/fashion-product-images-small", "data/train-00000-of-00002-6cff4c59f91661c3.parquet", repo_type="dataset")
t = pq.read_table(p, columns=["baseColour", "image"]).to_pylist()
LW = float(sys.argv[1]); EXTRA = [("lavender","#b8a5d8"),("magenta","#c2307a")] if len(sys.argv)>2 else []
PALETTE = [("black","#1c1c1c"),("grey","#8c8c8c"),("white","#f4f4f2"),("cream","#ece3cf"),("beige","#d6c09c"),
 ("khaki","#a8996a"),("brown","#6b4428"),("navy","#1f2a48"),("blue","#2f5fb3"),("lightblue","#9fc4e8"),("teal","#1d7874"),
 ("green","#2e7d3a"),("olive","#5c5a2c"),("yellow","#f0d03c"),("mustard","#c79f2a"),("orange","#e07a2c"),("red","#c42a2a"),
 ("burgundy","#6a1c2c"),("pink","#f0a5c0"),("purple","#6b3e9a")] + EXTRA
def srgb2lab(rgb):
    c = rgb/255.0; c = np.where(c > 0.04045, ((c+0.055)/1.055)**2.4, c/12.92)
    M = np.array([[0.4124,0.3576,0.1805],[0.2126,0.7152,0.0722],[0.0193,0.1192,0.9505]])
    xyz = c @ M.T / np.array([0.95047,1.0,1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787*xyz + 16/116)
    return np.stack([116*f[...,1]-16, 500*(f[...,0]-f[...,1]), 200*(f[...,1]-f[...,2])], -1)
PLAB = srgb2lab(np.array([[int(h[i:i+2],16) for i in (1,3,5)] for _,h in PALETTE], float))
def dominant(img):
    img = img.convert("RGB"); img.thumbnail((64,64)); a = np.asarray(img, float); h, w, _ = a.shape
    lab = srgb2lab(a.reshape(-1,3))
    border = np.concatenate([a[:2].reshape(-1,3), a[-2:].reshape(-1,3), a[:,:2].reshape(-1,3), a[:,-2:].reshape(-1,3)])
    bg = np.median(srgb2lab(border), 0)
    yy, xx = np.mgrid[0:h,0:w]; wgt = np.exp(-(((xx-w/2)/(w*0.35))**2 + ((yy-h/2)/(h*0.35))**2)/2).ravel()
    fg = np.linalg.norm(lab-bg, axis=1) > 15
    if (wgt*fg).sum() < 0.1*wgt.sum(): fg[:] = True   # garment same colour as background
    X, W = lab[fg], wgt[fg]
    # k-means, k=3, deterministic init by lightness quantiles
    C = X[np.argsort(X[:,0])][[int(q*(len(X)-1)) for q in (0.15,0.5,0.85)]].copy()
    for _ in range(10):
        lbl = np.argmin(((X[:,None]-C[None])**2).sum(-1), 1)
        for k in range(3):
            if (lbl==k).any(): C[k] = np.average(X[lbl==k], 0, W[lbl==k])
    mass = np.array([W[lbl==k].sum() for k in range(3)])
    best = C[np.argmax(mass)]
    d = PLAB-best; d[:,0] *= LW
    return PALETTE[np.argmin((d**2).sum(1))][0], best, fg.reshape(h,w)
OK = {"Navy Blue":{"navy"},"Blue":{"blue","navy","lightblue"},"Black":{"black"},"White":{"white","cream"},"Grey":{"grey"},
 "Red":{"red"},"Green":{"green","olive","teal"},"Brown":{"brown"},"Pink":{"pink","magenta"},"Purple":{"purple","magenta","lavender"},"Beige":{"beige","cream","khaki"},
 "Yellow":{"yellow","mustard"},"Orange":{"orange"},"Maroon":{"burgundy"},"Olive":{"olive","khaki"},"Cream":{"cream","beige","white"},
 "Khaki":{"khaki","beige","olive"},"Teal":{"teal"},"Mustard":{"mustard","yellow"},"Charcoal":{"grey","black"},"Off White":{"white","cream"},
 "Grey Melange":{"grey"},"Lavender":{"purple","pink","lavender"},"Turquoise Blue":{"teal","blue","lightblue"},"Magenta":{"pink","purple","magenta"},"Peach":{"pink","orange"}}
random.seed(2); rows = [r for r in t if r["baseColour"] in OK]; by = collections.defaultdict(list)
for r in rows: by[r["baseColour"]].append(r)
n = ok = 0; bad = collections.Counter()
for c, rs in by.items():
    for r in random.sample(rs, min(15, len(rs))):
        g, _, _ = dominant(Image.open(io.BytesIO(r["image"]["bytes"]))); n += 1
        if g in OK[c]: ok += 1
        else: bad[(c, g)] += 1
print(f"colour {ok}/{n} = {ok/n:.0%}")
for k, v in bad.most_common(12): print(v, k)
