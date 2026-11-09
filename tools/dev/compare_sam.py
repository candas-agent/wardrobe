import io, random, numpy as np, onnxruntime as ort, pyarrow.parquet as pq
from PIL import Image, ImageDraw
from huggingface_hub import hf_hub_download
so = ort.SessionOptions(); so.intra_op_num_threads = 4
S = lambda repo, f, rev=None: ort.InferenceSession(hf_hub_download(repo, f, revision=rev), so)
rev = "5850ab45f587c112167512ffef949107115e26a0"
slim_e, slim_d = S("Xenova/slimsam-77-uniform", "onnx/vision_encoder.onnx", rev), S("Xenova/slimsam-77-uniform", "onnx/prompt_encoder_mask_decoder_quantized.onnx", rev)
edge_e, edge_d = S("chongzhou/EdgeSAM", "edge_sam_3x_encoder.onnx"), S("chongzhou/EdgeSAM", "edge_sam_3x_decoder.onnx")
mob_e, mob_d = S("PulpCut/mobilesam-onnx", "mobilesam.encoder.onnx"), S("PulpCut/mobilesam-onnx", "mobilesam.decoder.onnx")

def resized(img):
    W, H = img.size; s = 1024 / max(W, H); nw, nh = round(W*s), round(H*s)
    return np.asarray(img.convert("RGB").resize((nw, nh), Image.BILINEAR), np.float32), s, nw, nh
def lowres_to_full(low, nw, nh, W, H):  # 256x256 logits over the padded 1024 square
    up = np.asarray(Image.fromarray(low.astype(np.float32)).resize((1024, 1024), Image.BILINEAR))[:nh, :nw]
    return np.asarray(Image.fromarray(up).resize((W, H), Image.BILINEAR)) > 0

def slimsam(img, pt):
    a, s, nw, nh = resized(img); W, H = img.size
    x = np.zeros((1, 3, 1024, 1024), np.float32); x[0, :, :nh, :nw] = ((a/255 - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1)
    emb, pos = slim_e.run(None, {"pixel_values": x})
    iou, m = slim_d.run(None, {"input_points": np.array([[[[pt[0]*s, pt[1]*s]]]], np.float32), "input_labels": np.array([[[1]]], np.int64),
                               "image_embeddings": emb, "image_positional_embeddings": pos})
    return [(lowres_to_full(m[0, 0, k], nw, nh, W, H), float(iou[0, 0, k])) for k in range(3)]

def edgesam(img, pt):
    a, s, nw, nh = resized(img); W, H = img.size
    x = np.zeros((1, 3, 1024, 1024), np.float32); x[0, :, :nh, :nw] = ((a - [123.675, 116.28, 103.53]) / [58.395, 57.12, 57.375]).transpose(2, 0, 1)
    emb, = edge_e.run(None, {"image": x})
    scores, m = edge_d.run(None, {"image_embeddings": emb, "point_coords": np.array([[[pt[0]*s, pt[1]*s]]], np.float32), "point_labels": np.array([[1]], np.float32)})
    return [(lowres_to_full(m[0, k], nw, nh, W, H), float(scores[0, k])) for k in range(m.shape[1])]

def mobilesam(img, pt):
    a, s, nw, nh = resized(img); W, H = img.size
    emb, = mob_e.run(None, {"input_image": a})
    out = []
    masks, iou, low = mob_d.run(None, {"image_embeddings": emb, "point_coords": np.array([[[pt[0]*s, pt[1]*s], [0, 0]]], np.float32),
        "point_labels": np.array([[1, -1]], np.float32), "mask_input": np.zeros((1, 1, 256, 256), np.float32),
        "has_mask_input": np.zeros(1, np.float32), "orig_im_size": np.array([H, W], np.float32)})
    return [(masks[0, k] > 0, float(iou[0, k])) for k in range(masks.shape[1])]

# test images: synthetic flat lay (3 taps) + a model wearing an outfit (tap the top)
flat = Image.open("/tmp/flatlay.jpg")
p = hf_hub_download("ashraq/fashion-product-images-small", "data/train-00000-of-00002-6cff4c59f91661c3.parquet", repo_type="dataset")
rows = [r for r in pq.read_table(p, columns=["articleType", "image"]).to_pylist() if r["articleType"] == "Tshirts"]
random.seed(11); person = Image.open(io.BytesIO(random.choice(rows)["image"]["bytes"])).convert("RGB").resize((600, 800), Image.LANCZOS)
cases = [("jeans", flat, (224, 295)), ("sweater", flat, (595, 285)), ("shoe", flat, (985, 662)), ("worn tee", person, (300, 330))]
models = [("SlimSAM (current)", slimsam), ("EdgeSAM-3x", edgesam), ("MobileSAM", mobilesam)]
T = 230
sheet = Image.new("RGB", (len(cases) * (T + 10) + 150, len(models) * (T + 30) + 10), "white"); d = ImageDraw.Draw(sheet)
for r, (mname, fn) in enumerate(models):
    d.text((5, r * (T + 30) + T // 2), mname, fill="black")
    for c, (cname, img, pt) in enumerate(cases):
        cands = fn(img, pt)
        mask, score = max(cands, key=lambda t: t[1])
        crop = img.convert("RGB"); W, H = crop.size
        dim = Image.blend(crop, Image.new("RGB", crop.size, "black"), 0.65)
        vis = Image.composite(crop, dim, Image.fromarray((mask * 255).astype(np.uint8)))
        ImageDraw.Draw(vis).ellipse([pt[0]-9, pt[1]-9, pt[0]+9, pt[1]+9], fill="lime", outline="white", width=3)
        # zoom on the item region for the flat lay
        box = {"jeans": (40, 40, 420, 560), "sweater": (400, 30, 790, 560), "shoe": (780, 420, 1180, 820), "worn tee": (0, 0, 600, 800)}[cname]
        tile = vis.crop(box); tile.thumbnail((T, T))
        x0, y0 = 150 + c * (T + 10), r * (T + 30) + 5
        sheet.paste(tile, (x0, y0)); d.text((x0, y0 + T + 2), f"{cname}: best of {len(cands)}, score {score:.2f}", fill="black")
sheet.save("/tmp/sam_compare.png"); print("ok")

import time
sheet = Image.new("RGB", (4 * (T + 10) + 150, 2 * (T + 30) + 10), "white"); d = ImageDraw.Draw(sheet)
for r, (cname, img, pt) in enumerate([cases[0], cases[3]]):
    d.text((5, r * (T + 30) + T // 2), f"EdgeSAM {cname}", fill="black")
    cands = edgesam(img, pt)
    crop = img.convert("RGB")
    box = {"jeans": (40, 40, 420, 560), "worn tee": (0, 0, 600, 800)}[cname]
    for k, (mask, score) in enumerate(cands):
        dim = Image.blend(crop, Image.new("RGB", crop.size, "black"), 0.65)
        vis = Image.composite(crop, dim, Image.fromarray((mask * 255).astype(np.uint8)))
        tile = vis.crop(box); tile.thumbnail((T, T)); x0, y0 = 150 + k * (T + 10), r * (T + 30) + 5
        sheet.paste(tile, (x0, y0)); d.text((x0, y0 + T + 2), f"#{k} score {score:.2f} area {mask.mean():.1%}", fill="black")
sheet.save("/tmp/edgesam_cands.png")
# decoder timing per tap
a, s, nw, nh = resized(flat)
x = np.zeros((1, 3, 1024, 1024), np.float32); x[0, :, :nh, :nw] = ((a - [123.675, 116.28, 103.53]) / [58.395, 57.12, 57.375]).transpose(2, 0, 1)
emb, = edge_e.run(None, {"image": x})
f = {"image_embeddings": emb, "point_coords": np.array([[[200., 250.]]], np.float32), "point_labels": np.array([[1]], np.float32)}
edge_d.run(None, f); t = time.time(); [edge_d.run(None, f) for _ in range(5)]; print(f"EdgeSAM decoder per tap: {(time.time()-t)/5*1000:.0f} ms")
xs = np.zeros((1, 3, 1024, 1024), np.float32); emb2, pos2 = slim_e.run(None, {"pixel_values": xs})
f2 = {"input_points": np.array([[[[200., 250.]]]], np.float32), "input_labels": np.array([[[1]]], np.int64), "image_embeddings": emb2, "image_positional_embeddings": pos2}
slim_d.run(None, f2); t = time.time(); [slim_d.run(None, f2) for _ in range(5)]; print(f"SlimSAM decoder per tap: {(time.time()-t)/5*1000:.0f} ms")
