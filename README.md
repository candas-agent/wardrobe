# Wardrobe

A phone-first PWA to keep an inventory of your clothes and combine them into outfits.
Everything is stored on the device (IndexedDB) — no account, no server.

- **Add** — the **+ Add** button on the Wardrobe tab opens the phone's picker (camera or gallery,
  several photos at once). If there are several items or a busy
  background, **tap the item**: it's cut out (pick one of 3 outlines; tap elsewhere to choose
  another item, tap the dot to undo). Item in several parts, like an open jacket? **Hold** on the
  other part to add it: all points go to the model together, which outlines the whole item.
  Tagging runs on the cut-out only. The app suggests the **type**
  (top-3 chips) and **colour** (dominant + secondary); correct with one tap.
  Cut-out items are stored on white; the original photo is kept too.
  If the photo is already in your wardrobe (same file, or the same picture re-saved/resized),
  a notice shows which items were made from it.
- **Wardrobe** — grid with search (name, notes, type, colour) and type/colour filters.
- **Outfits** — one swipe carousel per layer: Tops, Bottoms (incl. dresses) and Shoes by default,
  Outerwear and Accessories switched on with the buttons above (each row starts with "none");
  the centred item of each row is the outfit. Pictures are sized to fill the screen.
  **On me** shows the outfit full screen on a full-length photo of you (a paper doll, set in Settings):
  drag an item to move it, pinch to resize, double-tap to put it back, ✕ to close. Adjustments are
  saved on the item. Saved outfits get that picture in the Outfits list; it's redrawn when the photo
  or an item's adjustment changes (not included in backups, redrawn after an import).
- **Trips** — dates of a trip, one or more saved outfits per day, an automatic **packing list**
  (items of the planned outfits + extras, with "worn N days" and tick-off checkboxes), and
  **more outfits**: saved outfits made only of packed items (plan them in one tap) plus a
  mix & match carousel limited to the packing list.
- **Settings** — export/import a JSON backup (photos included), your photo for On me, AI model status.

The AI models download automatically on first launch (progress bar at the top); the app is
usable meanwhile and anything that needs them waits.

## How tagging works

- **Tap-to-select:** EdgeSAM-3x (`chongzhou/EdgeSAM`, 38 MB), a phone-sized Segment Anything.
  Chosen over SlimSAM-77 / MobileSAM / EfficientSAM after measuring: ~3x faster than SlimSAM in the
  browser with the same outline quality (45 test taps: mean IoU 0.966 best outline, 0.914 default).
  Licence: S-Lab License 1.0 (non-commercial); MobileSAM (Apache-2.0) is the fallback option if that
  ever matters. The image encoder runs once per photo (in the background, right after it loads);
  each tap only re-runs the small prompt decoder, so outlines appear in about a second.
- **Type:** OpenAI CLIP ViT-B/32 vision model (`Xenova/clip-vit-base-patch32`, int8, 89 MB)
  runs on the phone via onnxruntime-web. Its image embedding is compared with text embeddings
  of the clothing types, precomputed into `labels.json` — so the phone never needs the text model.
  Downloaded once (together with EdgeSAM: 127 MB), cached, then offline.
- **Colour:** k-means in Lab over the item's pixels — the cut-out mask if you tapped, otherwise
  background estimated from the border pixels plus centre weighting — then the nearest named
  colour from the palette in `catalog.js`.
- **On me:** MoveNet Thunder (`Xenova/movenet-singlepose-thunder`, full precision, 25 MB, Apache 2.0;
  the int8 and fp16 exports give garbage keypoints) finds shoulders, hips and ankles once, when the
  photo is set; downloaded only then. Items are placed by type (tops on the shoulder line, trousers
  waist to ankles, shoes per foot, ...) in shoulder-width units, so adjustments survive a new photo.
  Items saved before this have no transparency: the white around them is cleared instead.

Best results: one item, laid flat or on a hanger, plain background, good light.

## Files

| File | Role |
|---|---|
| `index.html`, `style.css`, `app.js` | UI and hash router |
| `db.js` | IndexedDB wrapper (`items`, `outfits`, `trips`, `settings`) |
| `catalog.js` | type groups + colour palette |
| `models.js` | model download/cache, onnxruntime sessions |
| `classify.js` | CLIP type detection + colour extraction |
| `segment.js` | EdgeSAM tap-to-select, cut-outs |
| `doll.js` | On me: MoveNet body pose, item placement |
| `fingerprint.js` | photo fingerprints (SHA-256 + 16×16 colour thumbnail) for duplicate warnings |
| `labels.json` | precomputed CLIP text embeddings (generated) |
| `sw.js`, `manifest.webmanifest`, `icons/` | offline + installable |
| `tools/` | Python script that generates `labels.json` |

## Speed

The SAM image encoder is the heavy step (it prepares a photo for tapping). To make it bearable:
- `sw.js` makes the app cross-origin isolated (adds COOP/COEP headers, serves onnxruntime
  same-origin under `./ort/`), so onnxruntime can use up to 4 threads — ~3.5x faster.
- Graphics chip (WebGPU) for the encoder: **opt-in experiment** in Settings. On an Android test
  phone it gave wrong outlines (accuracy-check error 1.09) and froze the phone while trying
  configurations. When switched on, the encoder is first checked on a fixed test pattern against
  reference numbers (`gpu-check.json`, made by `tools/make_gpu_check.py`); failure falls back to
  the processor and the reason is shown in Settings.
- Photos are shrunk step by step (`imaging.js`): one big drawImage shrink turns fine fabric weaves
  into false patterns (moiré). Settings shows where it runs and can switch the graphics chip off.
- Model sessions are created while the photo picker is open (`models.warmUp()`).
- One job queue (`models.run`): a tap's outline goes before queued type detection, and type
  detections that are no longer wanted are dropped before they start.

## Changing the clothing types

Edit `tools/labels.py`, then regenerate (needs `onnxruntime tokenizers numpy huggingface_hub`):

    python tools/make_label_embeddings.py

## Running locally

    python -m http.server 8000

and open http://localhost:8000 (service workers need localhost or HTTPS).
After deploying changes, bump `CACHE` in `sw.js`. Installed apps pick up the new version the next
time they come to the foreground (they reload themselves, except while adding/editing).
