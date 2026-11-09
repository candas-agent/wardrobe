import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import sys, json, numpy as np, onnxruntime as ort
from PIL import Image, ImageDraw, ImageFilter
from huggingface_hub import hf_hub_download
R = "Xenova/slimsam-77-uniform"; Q = "_quantized" if "q" in sys.argv else ""
enc = ort.InferenceSession(hf_hub_download(R, f"onnx/vision_encoder{Q}.onnx"))
dec = ort.InferenceSession(hf_hub_download(R, f"onnx/prompt_encoder_mask_decoder{Q}.onnx"))
exec(open("eval_colour.py").read().split("OK = {")[0].replace("LW = float(sys.argv[1])", "LW = 0.75").replace("if len(sys.argv)>2 else []", ""))

# synthetic flat lay: 3 items on a noisy wooden-ish background
rng = np.random.default_rng(0)
bg = (np.array([170, 140, 105]) + rng.normal(0, 12, (900, 1200, 1)) + 15*np.sin(np.arange(1200)/9)[None, :, None]).clip(0, 255).astype("uint8")
scene = Image.fromarray(bg)
spots = {"Jeans": (60, 80), "Sweaters": (430, 60), "Casual_Shoes": (820, 450)}
taps = {}
for name, (x, y) in spots.items():
    im = Image.open(f"/tmp/wardrobe-samples/{name}.jpg").convert("RGB").resize((330, 440), Image.LANCZOS)
    a = np.asarray(im).astype(int); mask = Image.fromarray(((np.abs(a - 255).sum(2) > 40) * 255).astype("uint8")).filter(ImageFilter.MedianFilter(5))
    scene.paste(im, (x, y), mask); bb = mask.getbbox(); taps[name] = (x + (bb[0]+bb[2])//2, y + (bb[1]+bb[3])//2)
scene.save("/tmp/flatlay.jpg", quality=90)

W, H = scene.size; s = 1024 / max(W, H); nw, nh = round(W*s), round(H*s)
a = (np.asarray(scene.resize((nw, nh), Image.BILINEAR), np.float32)/255 - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
px = np.zeros((1, 3, 1024, 1024), np.float32); px[0, :, :nh, :nw] = a.transpose(2, 0, 1)
emb, pos = enc.run(None, {"pixel_values": px})

labels = json.load(open(_REPO + "/labels.json")); E = np.array([l["emb"] for l in labels], np.float32)
clip = ort.InferenceSession(hf_hub_download("Xenova/clip-vit-base-patch32", "onnx/vision_model_quantized.onnx"))
def clip_top(img):
    w, h = img.size; sc = 224/min(w, h); img = img.resize((max(224, round(w*sc)), max(224, round(h*sc))), Image.BILINEAR)
    w, h = img.size; l, t = (w-224)//2, (h-224)//2
    x = ((np.asarray(img.crop((l, t, l+224, t+224)), np.float32)/255 - [0.48145466, 0.4578275, 0.40821073]) / [0.26862954, 0.26130258, 0.27577711]).transpose(2, 0, 1)[None].astype(np.float32)
    v = clip.run(None, {"pixel_values": x})[0][0]; sc = E @ (v/np.linalg.norm(v)); o = np.argsort(-sc)[:3]
    p = np.exp(100*sc - 100*sc.max()); p /= p.sum(); return [(labels[i]["id"], round(float(p[i]), 2)) for i in o]

out = scene.copy(); d = ImageDraw.Draw(out)
for name, (tx, ty) in taps.items():
    iou, m = dec.run(None, {"input_points": np.array([[[[tx*s, ty*s]]]], np.float32), "input_labels": np.array([[[1]]], np.int64),
                            "image_embeddings": emb, "image_positional_embeddings": pos})
    k = int(np.argmax(iou[0, 0])); low = m[0, 0, k]
    up = np.asarray(Image.fromarray(low).resize((1024, 1024), Image.BILINEAR))[:nh, :nw]
    mask = np.asarray(Image.fromarray(up).resize((W, H), Image.BILINEAR)) > 0
    ys, xs = np.nonzero(mask); bb = (xs.min(), ys.min(), xs.max()+1, ys.max()+1)
    cut = Image.composite(scene, Image.new("RGB", scene.size, "white"), Image.fromarray((mask*255).astype("uint8"))).crop(bb)
    cut.save(f"/tmp/cut_{name}.png")
    print(f"{name:13s} iou={iou[0,0].round(2)} pick={k} area={mask.mean():.1%} bbox={bb} type={clip_top(cut)} colour={dominant(cut)[0]}")
    tint = Image.new("RGB", scene.size, ["#ff0040", "#00c0ff", "#40ff00"][list(taps).index(name)])
    out = Image.composite(Image.blend(out, tint, 0.45), out, Image.fromarray((mask*255).astype("uint8"))); d = ImageDraw.Draw(out)
    d.ellipse([tx-10, ty-10, tx+10, ty+10], fill="yellow", outline="black", width=3)
out.save(f"/tmp/sam_overlay{Q}.png")

sheet = Image.new("RGB", (3*300, 2*300), "white")
for r, name in enumerate(["Jeans", "Sweaters"]):
    tx, ty = taps[name]
    iou, m = dec.run(None, {"input_points": np.array([[[[tx*s, ty*s]]]], np.float32), "input_labels": np.array([[[1]]], np.int64),
                            "image_embeddings": emb, "image_positional_embeddings": pos})
    for k in range(3):
        up = np.asarray(Image.fromarray(m[0, 0, k]).resize((1024, 1024), Image.BILINEAR))[:nh, :nw]
        mask = np.asarray(Image.fromarray(up).resize((W, H), Image.BILINEAR)) > 0
        cut = Image.composite(scene, Image.new("RGB", scene.size, "white"), Image.fromarray((mask*255).astype("uint8")))
        x, y = spots[name]; tile = cut.crop((x-20, y-20, x+350, y+470)).resize((280, 280))
        sheet.paste(tile, (k*300, r*300)); ImageDraw.Draw(sheet).text((k*300+5, r*300+282), f"mask {k} iou {iou[0,0,k]:.2f} area {mask.mean():.1%}", fill="black")
sheet.save("/tmp/sam_masks.png")

print("--- mask 2 (garment only)")
for name in ["Jeans", "Sweaters"]:
    tx, ty = taps[name]
    iou, m = dec.run(None, {"input_points": np.array([[[[tx*s, ty*s]]]], np.float32), "input_labels": np.array([[[1]]], np.int64),
                            "image_embeddings": emb, "image_positional_embeddings": pos})
    up = np.asarray(Image.fromarray(m[0, 0, 2]).resize((1024, 1024), Image.BILINEAR))[:nh, :nw]
    mask = np.asarray(Image.fromarray(up).resize((W, H), Image.BILINEAR)) > 0
    ys, xs = np.nonzero(mask); bb = (xs.min(), ys.min(), xs.max()+1, ys.max()+1)
    cut = Image.composite(scene, Image.new("RGB", scene.size, "white"), Image.fromarray((mask*255).astype("uint8"))).crop(bb)
    print(name, clip_top(cut), dominant(cut)[0])
