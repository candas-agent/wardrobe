# Status

*Updated 21 October 2026. Live version: commit `e6db1d2`, service-worker cache `wardrobe-app-v19`.*

The MVP and everything added since are live at https://candas-agent.github.io/wardrobe/. The
owner uses it on an **Android phone (Chrome)**; **iPhone has not been tried yet** (planned once
the app is more mature).

## Features

| Feature | State | Tested |
|---|---|---|
| Inventory: add photos (several at once), edit, delete, search, filters | Done | E2E; used on the owner's phone |
| Automatic type (CLIP) and colour suggestions | Done | Model evaluation (below); used on the phone |
| Tap-to-select cut-outs (EdgeSAM), several outlines to choose from | Done | E2E, 45-tap quality evaluation; owner confirmed “works fast” |
| Hold to add another part of an item (open jacket) | Done | E2E on the owner's jacket photo |
| Duplicate-photo warning | Done | E2E; fingerprint evaluation (below) |
| Outfit builder: swipe carousels per layer, optional Outerwear / Accessories rows | Done | E2E; used on the phone |
| On me: own photo, automatic placement, drag / pinch / double-tap | Done | E2E with a stock photo; used by the owner (reported doubled shoes, fixed) |
| On me full screen with ✕; outfit pictures in the Outfits list | Done | E2E with a stock photo; **not yet confirmed on the phone** |
| Trips: outfits per day, packing list, possible outfits, mix & match | Done | E2E |
| Backup export / import (v3 includes your photo and cut-outs) | Done | E2E |
| Offline, installable, self-updating | Done | E2E (offline test); updates confirmed on the phone |
| Graphics chip (WebGPU) for tap-to-select | Experimental, **off by default** | Wrong outlines and a frozen phone on the owner's Android, so opt-in only, with an accuracy check |

## Measurements

- **Type detection (CLIP, zero-shot):** 63 % right first guess, 90 % in the top 3 on a fashion
  product test set. It's a suggestion; corrections take one tap.
- **Tap-to-select:** EdgeSAM-3x encodes a photo in about 3.6 s, against 11.2 s for SlimSAM-77
  (desktop browser), with the same outline quality (45 test taps: mean IoU 0.966 for the best
  outline). On a 4× slowed-down processor: first tap 17.7 s (the photo is prepared in the
  background meanwhile), following taps 0.7 s.
- **Duplicate check:** the 16×16 picture fingerprint mistook about 0.01 % of unrelated photo pairs
  for the same picture; the difference-hash tried first: 2 %.
- **Body pose (MoveNet Thunder):** body points within about 0.1–0.2 shoulder widths of MediaPipe's
  on the test photo. The smaller Lightning model was worse at the ankles, and the int8 and fp16
  exports of Thunder are unusable (they return nonsense).

## Known limitations

- **On me is a collage.** Clothes don't wrap around the body or follow bent arms, and the clothes
  worn in your photo show wherever an item is narrower. Placement rules were tuned on a single
  stock photo; drag/pinch fixes individual items.
- **Shoe pairs:** a pair is recognised as two separate shapes, or one very wide one. A pair
  photographed overlapping at an angle can still be drawn on each foot.
- **Items saved before On me** (before 21 October 2026) have no transparent cut-out. The white
  around them is cleared instead, which can eat into white clothes at the edges. Uncut photos with
  a busy background show as a rectangle.
- **Type suggestions** are often only “close” (e.g. Blazer for a jacket, Coat for half a jacket).
- **The first tap on a new photo** waits for the photo to be prepared (a few seconds on a phone).
- **The graphics chip** is unreliable on at least one Android phone (see above).
- **Storage:** the browser may clear site data when the phone runs low on space unless it grants
  persistent storage. Export a backup regularly.
- **iPhone** is untested. Expected risks: Safari and the service worker's cross-origin isolation
  (multi-threading), memory with the larger models, and data eviction unless the app is installed
  to the Home Screen.

## Open points / ideas

- Test on an iPhone (owner's call, when the app is more mature).
- Tune On me placement on the owner's own photo (needs a screenshot of a real outfit).
- Use the On me pictures in the trip view too (only the Outfits list has them).
- Allow changing items inside the full-screen On me view (today: close, swipe, reopen).
- Move the Playwright tests into the repository (`tests/`), so they're versioned with the app.
- Add a licence file for the app code, if it's ever shared.
- If the app is ever used commercially: replace EdgeSAM (non-commercial licence) with MobileSAM.

## Key decisions

| Decision | Why |
|---|---|
| Everything on the phone; GitHub Pages hosting | Owner's requirement: local data, phone use, no server |
| Zero-shot CLIP with precomputed text embeddings | No training data needed, and the phone only runs the image half |
| EdgeSAM-3x instead of SlimSAM-77 | About 3× faster in the browser, same quality |
| One tap replaces the selection; hold adds a part | Owner wants no Add/Remove/Reset buttons; holding keeps two-part items possible |
| Multi-point prompt instead of merging outlines | Merging separate outlines of an open jacket pulled in the trousers |
| Graphics chip opt-in, single configuration | Wrong outlines (error 1.09), and trying 3 configurations froze the phone twice |
| Step-wise downscaling | One-step shrinking produced moiré on a fine jacket weave |
| Local paper doll rather than a cloud try-on | Realistic try-on needs a server (photos leave the phone) or multi-GB models; owner chose local |
| Adjustments per item, in shoulder widths | Fix once for every outfit; survives a new photo |
| Update reloads wait for work in progress | A reload during photo processing lost the photo (found in testing) |

## History

| Date | Commit | Change |
|---|---|---|
| 19 Oct | `0b65ead` | MVP: inventory, tap-to-select, type/colour tagging, outfits, backup |
| 19 Oct | `026ff9f` | Simpler: automatic model download, single-tap selection, sticky action bars, outfit carousels |
| 19 Oct | `fa450d8` | Duplicate-photo warnings, + Add on the Wardrobe tab, reliable updates |
| 20 Oct | `088756b` | Trips tab |
| 20 Oct | `eedec13` | 3 carousel rows by default, toggles for Outerwear / Accessories |
| 20 Oct | `9c995be` | Faster tap-to-select (threads, job queue), bigger trip pictures |
| 20 Oct | `50c9033`, `4505e55`, `ab436c5` | Graphics chip experiments and accuracy check |
| 20 Oct | `8965d91` | EdgeSAM, graphics chip opt-in, no moiré |
| 20 Oct | `b6bfe55` | Hold to add another part of an item |
| 21 Oct | `2217b76` | On me (paper doll) |
| 21 Oct | `447c7f2` | Shoe pairs placed once |
| 21 Oct | `e6db1d2` | On me full screen, outfit pictures in the list |
