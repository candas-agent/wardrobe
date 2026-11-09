import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import io, json, random, sys, collections
import numpy as np, pyarrow.parquet as pq, onnxruntime as ort
from PIL import Image
from huggingface_hub import hf_hub_download
p = hf_hub_download("ashraq/fashion-product-images-small", "data/train-00000-of-00002-6cff4c59f91661c3.parquet", repo_type="dataset")
t = pq.read_table(p, columns=["articleType", "baseColour", "image"]).to_pylist()
labels = json.load(open(_REPO + "/labels.json"))
E = np.array([l["emb"] for l in labels], dtype=np.float32)
ids = [l["id"] for l in labels]
sess = ort.InferenceSession(hf_hub_download("Xenova/clip-vit-base-patch32", "onnx/vision_model_quantized.onnx"))
MEAN = np.array([0.48145466, 0.4578275, 0.40821073]); STD = np.array([0.26862954, 0.26130258, 0.27577711])
def prep(img):
    img = img.convert("RGB")
    if PAD:
        w, h = img.size; m = max(w, h); bg = Image.new("RGB", (m, m), img.getpixel((0, 0))); bg.paste(img, ((m-w)//2, (m-h)//2)); img = bg
    w, h = img.size; s = 224 / min(w, h)
    img = img.resize((max(224, round(w*s)), max(224, round(h*s))), Image.BILINEAR)
    w, h = img.size; l, tp = (w-224)//2, (h-224)//2
    a = (np.asarray(img.crop((l, tp, l+224, tp+224)), dtype=np.float32)/255 - MEAN)/STD
    return a.transpose(2, 0, 1)[None].astype(np.float32)
MAP = {"Tshirts":"tshirt","Shirts":"shirt","Tops":"top","Sweaters":"jumper","Sweatshirts":"sweatshirt","Jackets":"jacket",
       "Blazers":"blazer","Trousers":"trousers","Jeans":"jeans","Shorts":"shorts","Skirts":"skirt","Leggings":"leggings",
       "Dresses":"dress","Jumpsuit":"jumpsuit","Casual Shoes":"sneakers","Sports Shoes":"sneakers","Formal Shoes":"shoes",
       "Heels":"heels","Flats":"shoes","Sandals":"sandals","Flip Flops":"sandals","Handbags":"bag","Backpacks":"bag",
       "Caps":"hat","Scarves":"scarf","Belts":"belt"}
PAD = len(sys.argv) > 1
random.seed(1)
by = collections.defaultdict(list)
for r in t:
    if r["articleType"] in MAP: by[r["articleType"]].append(r)
ok = top3 = n = 0; conf = collections.Counter()
for at, rows in sorted(by.items()):
    for r in random.sample(rows, min(12, len(rows))):
        v = sess.run(None, {"pixel_values": prep(Image.open(io.BytesIO(r["image"]["bytes"])))})[0][0]
        v /= np.linalg.norm(v); s = E @ v; order = np.argsort(-s)
        pred = ids[order[0]]; want = MAP[at]; n += 1
        ok += pred == want; top3 += want in [ids[i] for i in order[:3]]
        if pred != want: conf[(at, pred)] += 1
print(f"top1 {ok}/{n} = {ok/n:.0%}   top3 {top3/n:.0%}")
for k, c in conf.most_common(15): print(c, k)
