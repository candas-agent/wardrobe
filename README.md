# Wardrobe

A phone-first web app (PWA) to keep an inventory of your clothes, combine them into outfits, see
outfits on a photo of yourself and plan what to pack for a trip.

- **Live:** https://candas-agent.github.io/wardrobe/ (GitHub Pages, deployed from `main`)
- **Private by design:** everything is stored on the phone (IndexedDB). No account, no server; the
  AI models run on the phone too. The only downloads are the app itself, the models (once) and
  onnxruntime (once).
- **No build step:** plain HTML/CSS and JavaScript modules.

Current state, test results, known limitations and next steps: see [STATUS.md](STATUS.md).

---

## Using the app

Install it from the browser menu (“Add to Home screen”); it then works offline. On first launch the
AI helpers download automatically (127 MB, progress bar at the top). The app is usable meanwhile;
anything that needs them waits.

### Wardrobe (default tab)

- Grid of all items with search (name, notes, type, colour) and type/colour filter chips.
- **+ Add** (sticky top bar) opens the phone's picker: camera or gallery, several photos at once.
  Then, photo by photo (*Add clothes i of N*, **Skip** / **Save** always on top):
  - **Tap the item** if there are several things or a busy background. It's cut out and three
    outlines are offered; pick the best. Tap elsewhere to choose another item instead, tap the
    dot to undo.
  - **Hold** on another part of the same item to add it, e.g. the other side of an open jacket.
    Tap a dot to remove that part.
  - The **type** (top-3 suggestions) and **colour** (dominant + secondary) are suggested from the
    cut-out; correct with one tap. Name and notes are optional.
  - If the photo is already in the wardrobe (same file, or the same picture re-saved or resized),
    a notice shows which items were made from it.
- Tap an item to edit or delete it (**Delete** / **Save** on top). Cut-out items can show their
  original photo.

### Outfits

- **+ New** opens the builder: one swipe carousel per layer. Tops, Bottoms (incl. dresses) and
  Shoes by default; **+ Outerwear** and **+ Accessories** add their rows. Each row starts with
  “None”; the centred item of each row is the outfit. Pictures are sized to fill the screen.
- **👤 On me** shows the outfit full screen on your own photo (see Settings): drag an item to move
  it, pinch to resize, double-tap to put it back, **✕** (or Back) to close. Adjustments are saved
  on the item, so they apply in every outfit.
- Saved outfits are listed with their **On me picture** (when you have set a photo) and the item
  thumbnails. Pictures are redrawn automatically when your photo or an item's position changes.

### Trips

- A trip has a name and dates (up to 60 days). For each day, pick one or more saved outfits.
- **Packing list:** the items of the planned outfits plus extras you add, with “worn N days” and
  tick-off checkboxes.
- **More outfits:** saved outfits made only of packed items (plan them in one tap), plus a
  mix & match builder limited to the packing list.
- Changes save immediately.

### Settings

- **Backup:** export/import one JSON file with everything (photos included, as data URLs). On
  phones it opens the share sheet. The browser can clear site data when storage runs low, so
  export now and then.
- **Me:** a full-length photo of you for On me. Best: standing straight, facing the camera, head to
  feet, arms a little away from the body, plain background, fitted clothes. The first time, a
  25 MB body-pose model downloads. You're warned if your shoulders, hips and feet can't be found;
  items are then placed roughly.
- **AI helpers:** download status and where they run (number of processor cores). An
  **experimental** switch runs tap-to-select on the graphics chip (WebGPU). Off by default: on an
  Android test phone it gave wrong outlines and froze the phone.

**Best photos of items:** one item, laid flat or on a hanger, plain background, good light.

---

## How it works

### Architecture

```
index.html ── app.js (UI, hash router: #/ #/add #/item/<id> #/outfits #/outfit/<id|new>
   │                    #/trips #/trip/<id> #/mix/<tripId> #/settings)
   ├── db.js           IndexedDB wrapper
   ├── catalog.js      type groups, colour palette, labels.json loader
   ├── imaging.js      step-wise high-quality downscaling (avoids moiré)
   ├── fingerprint.js  duplicate-photo fingerprints
   ├── models.js       model download/cache, onnxruntime sessions, job queue, GPU opt-in
   ├── classify.js     CLIP type + k-means colour        (loaded on first use)
   ├── segment.js      EdgeSAM tap-to-select, cut-outs   (loaded on first use)
   └── doll.js         On me: MoveNet pose, placement, outfit pictures (loaded on first use)
sw.js                  offline cache, cross-origin isolation, onnxruntime proxy
```

### Data (IndexedDB `wardrobe`, version 3)

| Store | Record |
|---|---|
| `items` | `id, createdAt, type, colour, colour2, name, notes, photo` (JPEG, cut-out on white, ≤1280 px), `thumb` (≤400 px), `original` (the uncut photo or null), `source { sha256, tiny, name, size }` (duplicate check), `cutout` (transparent WebP, ≤900 px, for On me; items saved before On me have none), `fit { dx, dy, s }` (the On me adjustment, in shoulder widths) |
| `outfits` | `id, name, createdAt, itemIds, preview { blob, sig }` (the On me picture and what it was drawn from) |
| `trips` | `id, name, start, end` (`YYYY-MM-DD`), `days { date: [outfitId] }, extraItemIds, packed, createdAt` |
| `settings` | `me { photo, pose { W, H, kpts, ok }, createdAt }` |

The models are kept in the Cache API (`wardrobe-model-v1`); `localStorage` holds only the
graphics-chip preference (`wardrobe-gpu*`). Backup format version 3: everything except outfit
pictures (redrawn after an import); older backups still import.

### AI models (all on the phone, via onnxruntime-web 1.20.1)

| Job | Model | Size | When downloaded | Licence |
|---|---|---|---|---|
| Type | OpenAI CLIP ViT-B/32 vision, int8 (`Xenova/clip-vit-base-patch32`) | 89 MB | first launch | MIT |
| Tap-to-select | EdgeSAM-3x encoder + decoder (`chongzhou/EdgeSAM`) | 38 MB | first launch | S-Lab 1.0, non-commercial |
| On me | MoveNet SinglePose Thunder, full precision (`Xenova/movenet-singlepose-thunder`) | 25 MB | when the photo is first set | Apache 2.0 |

All model URLs are pinned to a commit, so a file can't change underneath the app.

- **Type:** the CLIP image embedding of the cut-out (on white, 224 px) is compared with text
  embeddings of 30 clothing types, precomputed into `labels.json` by
  `tools/make_label_embeddings.py`, so the phone never needs the text model. On a fashion test set:
  63 % right first guess, 90 % in the top 3.
- **Colour:** shrink to 64 px, Lab colour space; the item's pixels come from the cut-out mask, or
  else the background is estimated from the border. Centre-weighted k-means (k = 3), then the
  nearest of 22 named colours in `catalog.js` (lightness weighted 0.75).
- **Tap-to-select:** the EdgeSAM image encoder runs once per photo, in the background as soon as it
  loads. Each tap only runs the small prompt decoder, about a second. All tapped points go to the
  decoder as one prompt. That outlines a two-part item (an open jacket) better than joining separate
  outlines, which pulled in the trousers. The decoder's 4 masks are de-duplicated (overlap > 0.95).
  With one point, the best-scoring outline is suggested. With several, the model's single-answer
  output is suggested instead.
- **On me (paper doll):** MoveNet finds 17 body points on the photo once: a pass on the whole
  photo, then on a crop around the person. Items are placed by type, in shoulder-width units:
  - tops and outerwear: the garment's shoulder line on the shoulders;
  - trousers: waist to ankles;
  - shorts and skirts: at the waist;
  - shoes: on each foot (one mirrored), or once across both feet when the photo shows a pair (two
    shapes, or a very wide one);
  - hat, scarf, belt, bag: head, neck, waist, hand.

  The draw order is bottom, shoes, top, outerwear, accessories. Items saved before On me have no
  transparency, so the white connected to their border is cleared.

### Speed

The EdgeSAM image encoder is the heavy step.
- **Threads:** `sw.js` makes the page cross-origin isolated (adds COOP/COEP/CORP headers and serves
  onnxruntime same-origin under `./ort/`), so onnxruntime can use up to 4 threads, about 3.5× faster.
- **Ahead of time:** sessions are created while the photo picker is open (`models.warmUp()`).
- **One job queue** (`models.run`): a tap's outline goes before queued type detection, and type
  detections no longer wanted are dropped before they start.
- **Graphics chip:** opt-in only. When switched on, the encoder is first checked on a fixed test
  pattern against reference numbers (`gpu-check.json`, made by `tools/make_gpu_check.py`; relative
  error must be below 0.06). If it fails, it falls back to the processor and the reason is shown in
  Settings.

### Offline and updates (`sw.js`)

- **App files:** network-first, so updates arrive when online, with a cache fallback offline. They
  bypass the HTTP cache (GitHub Pages caches for 10 minutes).
- **Updates:** the app checks whenever it comes back to the foreground, then reloads itself. It
  waits while you are adding or editing something, or while your photo is being read.
- **onnxruntime** is fetched from jsDelivr once, cached, and served from `./ort/`.

---

## Development

### Run locally

    python -m http.server 8000

and open http://localhost:8000 (service workers need localhost or HTTPS).

### Deploy

Push to `main`; GitHub Pages serves the repository root. **Bump `CACHE` in `sw.js`** with every
change to app files, so installed apps pick up the new version. Add new app files to `SHELL` in
`sw.js` so they work offline.

### Tools (`tools/`, Python)

- `labels.py`: the clothing types (id, label, group, CLIP phrases).
- `make_label_embeddings.py`: regenerates `labels.json` after editing `labels.py`. Needs
  `onnxruntime tokenizers numpy huggingface_hub`.
- `make_gpu_check.py`: regenerates `gpu-check.json` (the graphics-chip accuracy reference) after
  changing the EdgeSAM encoder.

### Tests

End-to-end tests are Playwright (Python) scripts driving a phone-sized headless Chromium against
the local server. They are kept outside the repository, in `~/scratch/wardrobe-tools/`
(`e2e_*.py`; `eval_*.py` for the model evaluations). See STATUS.md for what was tested.

---

## Licences

- **App code:** no licence file yet; all rights reserved by the owner.
- **Models:** CLIP is MIT and MoveNet is Apache 2.0. EdgeSAM is under the S-Lab License 1.0, which
  allows **non-commercial** use only. MobileSAM (Apache 2.0) is the drop-in alternative if the app
  is ever used commercially.
