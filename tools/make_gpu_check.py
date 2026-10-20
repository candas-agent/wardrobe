"""Reference numbers for the graphics-chip accuracy check -> gpu-check.json.

The app runs the SAM image encoder on WebGPU with a fixed synthetic input (same formula as
testPattern() in models.js) and compares a pooled summary of the output with these numbers,
computed here with the full-precision model on the CPU. Some phone GPUs silently return wrong
results; this catches that and the app falls back to the processor.

    python tools/make_gpu_check.py
"""
import json, os
import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download

POOL = 16  # 64x64 embedding grid -> 4x4 per channel

def test_pattern():
    c, y, x = np.meshgrid(np.arange(3), np.arange(1024), np.arange(1024), indexing="ij")
    v = 1.5 * np.sin(0.07 * x + 1.3 * c) * np.cos(0.05 * y) + 0.6 * np.sin(0.013 * (x + 2 * y) + c)
    return v.astype(np.float32)[None]

def summary(emb):  # (1, 256, 64, 64) -> 256 * 4 * 4
    e = emb[0].reshape(256, 64 // POOL, POOL, 64 // POOL, POOL).mean(axis=(2, 4))
    return e.flatten()

path = hf_hub_download("Xenova/slimsam-77-uniform", "onnx/vision_encoder.onnx",
                       revision="5850ab45f587c112167512ffef949107115e26a0")
emb = ort.InferenceSession(path).run(["image_embeddings"], {"pixel_values": test_pattern()})[0]
s = summary(emb)
dst = os.path.join(os.path.dirname(__file__), "..", "gpu-check.json")
with open(dst, "w") as f:
    json.dump({"pool": POOL, "summary": [float(f"{v:.5g}") for v in s]}, f, separators=(",", ":"))
print("wrote", len(s), "values, norm", float(np.linalg.norm(s)), "to", os.path.abspath(dst))
