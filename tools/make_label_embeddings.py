"""Precompute CLIP text embeddings for the clothing types -> labels.json.

Run with a venv that has onnxruntime, tokenizers, numpy, huggingface_hub:
    python tools/make_label_embeddings.py
"""
import json, os
import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer
from labels import TYPES, TEMPLATES

REPO = "Xenova/clip-vit-base-patch32"
tok = Tokenizer.from_file(hf_hub_download(REPO, "tokenizer.json"))
sess = ort.InferenceSession(hf_hub_download(REPO, "onnx/text_model.onnx"))

def embed(text):
    ids = np.array([tok.encode(text).ids], dtype=np.int64)
    v = sess.run(None, {"input_ids": ids})[0][0]
    return v / np.linalg.norm(v)

out = []
for tid, label, group, phrases in TYPES:
    vs = [embed(t.format(p)) for p in phrases for t in TEMPLATES]
    m = np.mean(vs, axis=0)
    m /= np.linalg.norm(m)
    out.append({"id": tid, "label": label, "group": group,
                "emb": [round(float(x), 5) for x in m]})

dst = os.path.join(os.path.dirname(__file__), "..", "labels.json")
with open(dst, "w") as f:
    json.dump(out, f, separators=(",", ":"))
print("wrote", len(out), "types to", os.path.abspath(dst))
