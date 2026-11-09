import os as _os; _REPO = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")); _SCRATCH = _os.environ.get("WARDROBE_SCRATCH", _os.path.expanduser("~/scratch"))  # paths: repo root, and scratch dir (Chrome profile, downloaded models)
import sys, numpy as np, onnxruntime as o
from PIL import Image
exec(open("paperdoll.py").read().split("def row_width")[0].split("def cut")[0])
exec("def pose" + open("paperdoll.py").read().split("def pose")[1].split("def row_width")[0])
COCO = {5: 11, 6: 12, 11: 23, 12: 24, 13: 25, 14: 26, 15: 27, 16: 28}  # movenet -> mediapipe index
def movenet(path, f, n=256):
    im = Image.open(path).convert("RGB"); W, H = im.size; S = max(W, H)
    sq = Image.new("RGB", (S, S)); sq.paste(im, (0, 0))
    x = np.asarray(sq.resize((n, n), Image.BILINEAR), np.int32)[None]
    out = o.InferenceSession(f).run(None, {"input": x})[0][0, 0]
    return {i: (np.array([out[i, 1] * S, out[i, 0] * S]), out[i, 2]) for i in range(17)}
mp_ = pose(sys.argv[1])
for f, n in [("lightning.onnx", 192), ("model.onnx", 256)]:
    mv = movenet(sys.argv[1], _SCRATCH + "/dl-movenet/" + f, n)
    sw = np.linalg.norm(mp_[11] - mp_[12])
    print(f, " ".join(f"{k}:{np.linalg.norm(mv[k][0] - mp_[v]) / sw:.2f}(s{mv[k][1]:.2f})" for k, v in COCO.items()))
