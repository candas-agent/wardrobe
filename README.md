# Wardrobe

A phone-first PWA to keep an inventory of your clothes and combine them into outfits.
Everything is stored on the device (IndexedDB) — no account, no server.

- **Add** — the **+ Add** button on the Wardrobe tab opens the phone's picker (camera or gallery,
  several photos at once). If there are several items or a busy
  background, **tap the item**: it's cut out (pick one of 3 outlines; tap elsewhere to choose
  another item, tap the dot to undo) and tagging runs on the cut-out only. The app suggests the **type**
  (top-3 chips) and **colour** (dominant + secondary); correct with one tap.
  Cut-out items are stored on white; the original photo is kept too.
  If the photo is already in your wardrobe (same file, or the same picture re-saved/resized),
  a notice shows which items were made from it.
- **Wardrobe** — grid with search (name, notes, type, colour) and type/colour filters.
- **Outfits** — one swipe carousel per layer (Outerwear, Tops, Bottoms incl. dresses, Shoes,
  Accessories; each starts with "none"); the centred item of each row is the outfit.
- **Trips** — dates of a trip, one or more saved outfits per day, an automatic **packing list**
  (items of the planned outfits + extras, with "worn N days" and tick-off checkboxes), and
  **more outfits**: saved outfits made only of packed items (plan them in one tap) plus a
  mix & match carousel limited to the packing list.
- **Settings** — export/import a JSON backup (photos included), AI model status.

The AI models download automatically on first launch (progress bar at the top); the app is
usable meanwhile and anything that needs them waits.

## How tagging works

- **Tap-to-select:** SlimSAM-77 (`Xenova/slimsam-77-uniform`, int8, 14 MB), a distilled Segment
  Anything model. The image encoder runs once per photo (in the background, right after it loads);
  each tap only re-runs the small prompt decoder, so outlines appear in about a second.
- **Type:** OpenAI CLIP ViT-B/32 vision model (`Xenova/clip-vit-base-patch32`, int8, 89 MB)
  runs on the phone via onnxruntime-web. Its image embedding is compared with text embeddings
  of the clothing types, precomputed into `labels.json` — so the phone never needs the text model.
  Downloaded once (together with SlimSAM: 103 MB), cached, then offline.
- **Colour:** k-means in Lab over the item's pixels — the cut-out mask if you tapped, otherwise
  background estimated from the border pixels plus centre weighting — then the nearest named
  colour from the palette in `catalog.js`.

Best results: one item, laid flat or on a hanger, plain background, good light.

## Files

| File | Role |
|---|---|
| `index.html`, `style.css`, `app.js` | UI and hash router |
| `db.js` | IndexedDB wrapper (`items`, `outfits`, `trips`) |
| `catalog.js` | type groups + colour palette |
| `models.js` | model download/cache, onnxruntime sessions |
| `classify.js` | CLIP type detection + colour extraction |
| `segment.js` | SlimSAM tap-to-select, cut-outs |
| `fingerprint.js` | photo fingerprints (SHA-256 + 16×16 colour thumbnail) for duplicate warnings |
| `labels.json` | precomputed CLIP text embeddings (generated) |
| `sw.js`, `manifest.webmanifest`, `icons/` | offline + installable |
| `tools/` | Python script that generates `labels.json` |

## Changing the clothing types

Edit `tools/labels.py`, then regenerate (needs `onnxruntime tokenizers numpy huggingface_hub`):

    python tools/make_label_embeddings.py

## Running locally

    python -m http.server 8000

and open http://localhost:8000 (service workers need localhost or HTTPS).
After deploying changes, bump `CACHE` in `sw.js`. Installed apps pick up the new version the next
time they come to the foreground (they reload themselves, except while adding/editing).
