import * as db from './db.js';
import { GROUPS, PALETTE, colourById, loadTypes } from './catalog.js';

const view = document.getElementById('view');
import * as models from './models.js';
import * as fp from './fingerprint.js';
import { shrink, fit } from './imaging.js';

const classifier = () => import('./classify.js'); // loaded lazily; onnxruntime itself loads on first use

let types = [], typeById = {};
const filters = { q: '', group: '', colour: '' };
let addQueue = [], addTotal = 0;
let currentDraft = null; // draft shown in the add form; late type results for other drafts are dropped
let builder = null; // outfit being edited: { key, id (null if new), name, createdAt, picks: { layer: itemId|null } }

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = view) => root.querySelector(sel);
const $$ = (sel, root = view) => [...root.querySelectorAll(sel)];

const urls = new Map(); // blob -> object URL, so thumbnails aren't re-created on every render
function blobUrl(blob) {
  if (!blob) return '';
  if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob));
  return urls.get(blob);
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

const typeLabel = id => typeById[id]?.label ?? 'Unsorted';
const itemTitle = item => item.name || [colourById[item.colour]?.label, typeLabel(item.type)].filter(Boolean).join(' ');
const dot = id => id ? `<i class="dot" style="background:${colourById[id]?.hex}"></i>` : '';

function matches(item, { q, group, colour }) {
  if (group && typeById[item.type]?.group !== group) return false;
  if (colour && item.colour !== colour && item.colour2 !== colour) return false;
  if (!q) return true;
  const hay = [item.name, item.notes, typeLabel(item.type), typeById[item.type]?.group,
    colourById[item.colour]?.label, colourById[item.colour2]?.label].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}

const itemCard = (item, { href, selected } = {}) => `
  <a class="card${selected ? ' sel' : ''}" ${href ? `href="${href}"` : 'role="button"'} data-id="${item.id}">
    <img src="${blobUrl(item.thumb)}" alt="" loading="lazy">
    <div class="meta">${dot(item.colour)}<span>${esc(itemTitle(item))}</span></div>
  </a>`;

const groupChips = active => `<div class="chips" data-chips="group">
  <button class="chip${!active ? ' on' : ''}" data-v="">All</button>
  ${GROUPS.map(g => `<button class="chip${active === g ? ' on' : ''}" data-v="${g}">${g}</button>`).join('')}
</div>`;

function onChips(name, cb) {
  $(`[data-chips="${name}"]`)?.addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    $$(`[data-chips="${name}"] .chip`).forEach(c => c.classList.toggle('on', c === b));
    cb(b.dataset.v);
  });
}

async function resizeToBlob(source, max, quality, type = 'image/jpeg') {
  const c = fit(source, max);
  if (c instanceof OffscreenCanvas) return c.convertToBlob({ type, quality });
  const copy = new OffscreenCanvas(c.width, c.height); // an ImageBitmap that's already small enough
  copy.getContext('2d').drawImage(c, 0, 0);
  return copy.convertToBlob({ type, quality }); // browsers without WebP encoding give PNG instead
}

// ---------- wardrobe ----------

async function wardrobeView() {
  const items = (await db.getAll('items')).sort((a, b) => b.createdAt - a.createdAt);
  const header = `<div class="topbar">
      <strong class="title">Wardrobe${items.length ? ` <span class="muted">${items.length}</span>` : ''}</strong>
      ${addButton('+ Add')}
    </div>`;
  if (!items.length) {
    view.innerHTML = header + `
      <div class="empty"><div class="big">👗</div><p>No clothes yet.</p>${addButton('Add your first item', 'addFirst')}</div>`;
    bindAddButtons();
    return;
  }
  const colours = PALETTE.filter(c => items.some(i => i.colour === c.id || i.colour2 === c.id));
  view.innerHTML = header + `
    <input type="search" id="q" placeholder="Search: e.g. blue jeans" value="${esc(filters.q)}">
    ${groupChips(filters.group)}
    <div class="chips" data-chips="colour">
      <button class="chip${!filters.colour ? ' on' : ''}" data-v="">Any colour</button>
      ${colours.map(c => `<button class="chip${filters.colour === c.id ? ' on' : ''}" data-v="${c.id}">${dot(c.id)}${c.label}</button>`).join('')}
    </div>
    <div class="grid" id="grid"></div>`;

  const renderGrid = () => {
    const shown = items.filter(i => matches(i, filters));
    $('#grid').innerHTML = shown.length
      ? shown.map(i => itemCard(i, { href: `#/item/${i.id}` })).join('')
      : `<p class="muted">Nothing matches.</p>`;
  };
  bindAddButtons();
  $('#q').addEventListener('input', e => { filters.q = e.target.value.trim(); renderGrid(); });
  onChips('group', v => { filters.group = v; renderGrid(); });
  onChips('colour', v => { filters.colour = v; renderGrid(); });
  renderGrid();
}

// ---------- item form (shared by add + edit) ----------

function itemForm(draft, { saveLabel, photoHtml, extra = '' }) {
  const options = GROUPS.map(g => `<optgroup label="${g}">${types.filter(t => t.group === g)
    .map(t => `<option value="${t.id}"${draft.type === t.id ? ' selected' : ''}>${t.label}</option>`).join('')}</optgroup>`).join('');
  return `
    ${photoHtml ?? `<img class="photo" src="${blobUrl(draft.photo)}" alt="">`}
    <label class="field">Type</label>
    <div class="chips wrap" id="typeSuggest"></div>
    <select id="type"><option value="">Choose type…</option>${options}</select>
    <label class="field">Colour</label>
    <div class="chips wrap" id="colourSuggest"></div>
    <div class="chips wrap" id="swatches">${PALETTE.map(c =>
      `<button class="swatch" data-v="${c.id}" title="${c.label}" aria-label="${c.label}" style="background:${c.hex}"></button>`).join('')}</div>
    <label class="field">Name (optional)</label>
    <input type="text" id="name" placeholder="e.g. Grandpa's tweed jacket" value="${esc(draft.name)}">
    <label class="field">Notes (optional)</label>
    <textarea id="notes" placeholder="Brand, size, where it's stored…">${esc(draft.notes)}</textarea>
    ${extra}
    ${saveLabel ? `<div class="actions" id="formActions">${saveLabel}</div>` : ''}`;
}

// Wires up the form; draft is mutated in place as the user picks values.
function bindItemForm(draft) {
  const syncType = () => {
    $('#type').value = draft.type || '';
    $('#typeSuggest').innerHTML = (draft.typeSuggestions ?? []).map(s =>
      `<button class="chip${draft.type === s.id ? ' on' : ''}" data-v="${s.id}">${s.label} <small>${Math.round(s.p * 100)}%</small></button>`).join('')
      + (draft.typeStatus ? `<span class="status">${esc(draft.typeStatus)}</span>` : '');
  };
  const syncColour = () => {
    $('#colourSuggest').innerHTML = (draft.colourSuggestions ?? []).map(id =>
      `<button class="chip${draft.colour === id ? ' on' : ''}" data-v="${id}">${dot(id)}${colourById[id].label}</button>`).join('');
    $$('#swatches .swatch').forEach(s => s.classList.toggle('on', s.dataset.v === draft.colour));
  };
  $('#typeSuggest').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    draft.type = b.dataset.v; draft.typeManual = true; syncType();
  });
  $('#type').addEventListener('change', e => { draft.type = e.target.value; draft.typeManual = true; syncType(); });
  const pickColour = e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    draft.colour = b.dataset.v;
    draft.colourManual = true;
    // keep a detected second colour (e.g. stripes) for search/filters
    draft.colour2 = draft.colourSuggestions?.find(c => c !== draft.colour) ?? draft.colour2;
    if (draft.colour2 === draft.colour) draft.colour2 = '';
    syncColour();
  };
  $('#colourSuggest').addEventListener('click', pickColour);
  $('#swatches').addEventListener('click', pickColour);
  $('#name').addEventListener('input', e => { draft.name = e.target.value; });
  $('#notes').addEventListener('input', e => { draft.notes = e.target.value; });
  syncType(); syncColour();
  return { syncType, syncColour };
}

const toItem = d => ({
  id: d.id, createdAt: d.createdAt, type: d.type, colour: d.colour, colour2: d.colour2 || '',
  name: d.name.trim(), notes: d.notes.trim(), photo: d.photo, thumb: d.thumb, original: d.original ?? null,
  source: d.source ?? null, cutout: d.cutout ?? null, fit: d.fit ?? null,
});

// ---------- duplicate warning ----------

// Items whose photo is the same file, or the same picture re-saved (resized/recompressed).
const findDupes = (items, source) => items.filter(i => i.source && (i.source.sha256 === source.sha256
  || i.source.tiny && fp.distance(i.source.tiny, source.tiny) <= fp.SAME_PICTURE));

const dupeNotice = dupes => !dupes.length ? '' : `
  <div class="notice">
    <strong>This photo is already in your wardrobe</strong>
    <div class="dupes">${dupes.map(i => `<a href="#/item/${i.id}"><img src="${blobUrl(i.thumb)}" alt="">
      <span>${esc(itemTitle(i))}<br><small class="muted">added ${new Date(i.createdAt).toLocaleDateString()}</small></span></a>`).join('')}</div>
    <small class="muted">Skip it, or tap another item in the photo to add that one.</small>
  </div>`;

// Items added before fingerprints existed: fingerprint their stored photo (no sha256, the file is gone).
async function backfillFingerprints() {
  for (const item of await db.getAll('items')) {
    if (item.source?.tiny) continue;
    try {
      const bmp = await createImageBitmap(item.original ?? item.photo);
      const tiny = fp.tiny(bmp);
      bmp.close();
      const fresh = await db.get('items', item.id); // the user may have edited it meanwhile
      if (fresh) await db.put('items', { ...fresh, source: { ...fresh.source, tiny } });
    } catch (err) { console.warn('fingerprint', item.id, err); }
  }
}

// ---------- add ----------

// The Add button opens the phone's picker directly (it offers camera and gallery), then the add flow.
const addButton = (label, id = 'addFiles') =>
  `<label class="btn primary">${label}<input type="file" accept="image/*" multiple hidden id="${id}" class="add-files"></label>`;

function bindAddButtons() {
  $$('.add-files').forEach(input => input.addEventListener('click', () => models.warmUp())); // while the picker is open
  $$('.add-files').forEach(input => input.addEventListener('change', () => {
    addQueue = [...input.files];
    addTotal = addQueue.length;
    if (addQueue.length) location.hash = '#/add';
  }));
}

async function addView() {
  if (addQueue.length) return addNext();
  location.replace('#/'); // nothing queued (e.g. back/forward or a reload): show the wardrobe
}

const stageHtml = `
  <canvas class="stage tappable" id="stage"></canvas>
  <div class="status" id="segStatus">Several things in the photo? Tap the item you want.</div>
  <div class="cands" id="cands"></div>`;

async function addNext() {
  const file = addQueue.shift();
  if (!file) return location.replace('#/'); // batch done: back to the wardrobe
  view.innerHTML = `<h1>Add clothes</h1><p class="status">Reading photo…</p>`;
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    toast("Couldn't read that image");
    return addNext();
  }
  // working copy at storage resolution; segmentation and the cut-out are done on this
  let work = fit(bmp, 1280); // step-by-step: a single big shrink adds false patterns to fine fabrics
  if (work === bmp) { work = new OffscreenCanvas(bmp.width, bmp.height); work.getContext('2d').drawImage(bmp, 0, 0); }
  bmp.close();
  const [photo, thumb, sha256, items] = await Promise.all([
    resizeToBlob(work, 1280, 0.92), resizeToBlob(work, 400, 0.85), fp.sha256(file), db.getAll('items')]);
  const source = { sha256, tiny: fp.tiny(work), name: file.name, size: file.size };
  const dupes = findDupes(items, source);
  const draft = {
    id: db.newId(), createdAt: Date.now(), type: '', colour: '', colour2: '', name: '', notes: '',
    photo, thumb, work, source, points: [], masks: null, maskIdx: 0, cut: null,
  };
  currentDraft = draft;

  const cls = await classifier();
  if (!location.hash.startsWith('#/add')) return; // user navigated away meanwhile

  const pos = addTotal > 1 ? ` <span class="muted">${addTotal - addQueue.length} of ${addTotal}</span>` : '';
  view.innerHTML = `<div class="topbar">
      <strong class="title">Add clothes${pos}</strong>
      <button class="btn" id="skip">Skip</button><button class="btn primary" id="save">Save</button>
    </div>` + dupeNotice(dupes) + itemForm(draft, { photoHtml: stageHtml });
  const form = bindItemForm(draft);
  const stage = $('#stage');
  stage.width = work.width;
  stage.height = work.height;
  drawStage(draft);

  $('#skip').addEventListener('click', () => addNext());
  $('#save').addEventListener('click', async () => {
    if (draft.cut) {
      const flat = seg().then(m => m.onWhite(draft.cut));
      draft.original = draft.photo;
      [draft.photo, draft.thumb, draft.cutout] = await Promise.all([resizeToBlob(await flat, 1280, 0.92), resizeToBlob(await flat, 400, 0.85),
        resizeToBlob(draft.cut, 900, 0.9, 'image/webp')]); // keeps the transparency, for 'On me'
    }
    await db.put('items', toItem(draft));
    navigator.storage?.persist?.(); // ask the browser not to evict our data
    toast('Saved');
    addNext();
  });

  // A tap selects the item under it (replacing any previous selection). Holding adds another part
  // to the selection, e.g. the other side of an open jacket: all points go to the model together,
  // which outlines the whole item better than joining separate outlines. Tapping a dot removes it.
  const toPhoto = e => {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * work.width, y: (e.clientY - r.top) / r.height * work.height };
  };
  let hold = null, held = false;
  const cancelHold = () => { clearTimeout(hold?.timer); hold = null; };
  stage.addEventListener('pointerdown', e => {
    if (!e.isPrimary) return;
    held = false;
    const at = toPhoto(e);
    hold = { cx: e.clientX, cy: e.clientY, timer: setTimeout(() => {
      hold = null;
      held = true;
      if (!draft.points.length || hitDot(draft, stage, at) >= 0) return; // nothing to add to: the click handles it
      navigator.vibrate?.(30);
      draft.points = [...draft.points, { ...at, include: true }];
      runSegment(draft, form);
    }, HOLD_MS) };
  });
  stage.addEventListener('pointermove', e => {
    if (hold && Math.hypot(e.clientX - hold.cx, e.clientY - hold.cy) > 12) cancelHold(); // scrolling, not holding
  });
  stage.addEventListener('pointerup', cancelHold);
  stage.addEventListener('pointercancel', cancelHold);
  stage.addEventListener('contextmenu', e => e.preventDefault()); // the long-press menu would get in the way
  stage.addEventListener('click', e => {
    if (held && draft.points.length) { held = false; return; } // the hold already added a point
    held = false;
    const at = toPhoto(e);
    const hit = hitDot(draft, stage, at);
    if (hit >= 0) {
      if (draft.points.length === 1) return resetSelection(draft, form, cls);
      draft.points = draft.points.filter((_, i) => i !== hit);
    } else {
      draft.points = [{ ...at, include: true }];
    }
    runSegment(draft, form);
  });

  retag(draft, form, cls, work, true);
  // start the heavy SAM encoder in the background so the first tap feels instant
  draft.enc = seg().then(m => m.encode(work));
  draft.enc.then(() => { draft.encReady = true; }, () => { draft.enc = null; });
}

function resetSelection(draft, form, cls) {
  Object.assign(draft, { points: [], masks: null, cut: null });
  $('#cands').innerHTML = '';
  $('#segStatus').textContent = 'Several things in the photo? Tap the item you want.';
  drawStage(draft);
  retag(draft, form, cls, draft.work, true);
}

const dotRadius = stage => Math.max(8, stage.width / 70);
const HOLD_MS = 450;
// index of the selection dot under a tap, or -1
const hitDot = (draft, stage, at) => draft.points.findIndex(p => Math.hypot(p.x - at.x, p.y - at.y) < dotRadius(stage) * 1.8);

const seg = () => import('./segment.js');
const doll = () => import('./doll.js');

function drawStage(draft) {
  const stage = $('#stage');
  if (!stage) return;
  const ctx = stage.getContext('2d');
  ctx.clearRect(0, 0, stage.width, stage.height);
  ctx.drawImage(draft.work, 0, 0);
  const mask = draft.masks?.[draft.maskIdx];
  if (mask) {
    // dim everything outside the selection, tint the selection
    const dimmed = new OffscreenCanvas(stage.width, stage.height);
    const d = dimmed.getContext('2d');
    d.fillStyle = 'rgba(0,0,0,.55)';
    d.fillRect(0, 0, stage.width, stage.height);
    d.globalCompositeOperation = 'destination-out';
    d.drawImage(mask.canvas, 0, 0);
    ctx.drawImage(dimmed, 0, 0);
  }
  const r = dotRadius(stage);
  for (const p of draft.points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#2e9d4a';
    ctx.fill();
    ctx.lineWidth = r / 3;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
}

async function runSegment(draft, form) {
  const status = $('#segStatus');
  status.textContent = draft.encReady ? 'Finding the item…' : 'Getting this photo ready for tapping (only the first tap waits)…';
  drawStage(draft);
  try {
    const m = await seg();
    draft.enc ??= m.encode(draft.work);
    const enc = await draft.enc;
    draft.encReady = true;
    const points = draft.points;
    const res = await m.segment(enc, points);
    if (draft !== currentDraft || points !== draft.points) return; // a newer tap replaced this one
    draft.masks = res.masks;
    draft.maskIdx = res.best;
    status.textContent = points.length > 1
      ? 'Pick the best outline below. Hold to add more, tap a dot to remove it.'
      : 'Pick the best outline below. Item in several parts (like an open jacket)? Hold on the other part to add it.';
    renderCands(draft, form);
    applyMask(draft, form);
  } catch (err) {
    console.error(err);
    draft.enc = null; // retry the encoder on the next tap
    status.textContent = `Couldn't cut out: ${err.message}`;
  }
}

async function renderCands(draft, form) {
  const m = await seg();
  const box = $('#cands');
  box.innerHTML = '';
  draft.masks.forEach((mask, i) => {
    const b = document.createElement('button');
    b.className = 'cand' + (i === draft.maskIdx ? ' on' : '');
    b.setAttribute('aria-label', `Outline ${i + 1} of ${draft.masks.length}`);
    const c = document.createElement('canvas');
    if (mask.bbox) {
      const small = fit(m.cutout(draft.work, mask), 160);
      c.width = small.width;
      c.height = small.height;
      c.getContext('2d').drawImage(small, 0, 0);
    }
    b.append(c);
    b.addEventListener('click', () => {
      draft.maskIdx = i;
      $$('#cands .cand').forEach((x, j) => x.classList.toggle('on', j === i));
      applyMask(draft, form);
    });
    box.append(b);
  });
}

async function applyMask(draft, form) {
  const m = await seg();
  const mask = draft.masks[draft.maskIdx];
  draft.cut = mask.bbox ? m.cutout(draft.work, mask) : null;
  drawStage(draft);
  retag(draft, form, await classifier(), draft.cut ?? draft.work, true);
}

// Detects colour (and type, if the model is there) on source; never overrides a manual pick.
async function retag(draft, form, cls, source, withType) {
  const token = draft.tagToken = {};
  try {
    draft.colourSuggestions = cls.dominantColours(source);
    if (!draft.colourManual) [draft.colour, draft.colour2 = ''] = draft.colourSuggestions;
  } catch (err) { console.warn(err); }
  form.syncColour();
  if (!withType) return;
  draft.typeStatus = 'Detecting type…';
  form.syncType();
  try {
    const ranked = await cls.classifyType(source, { stale: () => draft.tagToken !== token || draft !== currentDraft });
    if (draft.tagToken !== token) return;
    draft.typeSuggestions = ranked.slice(0, 3);
    if (!draft.typeManual) draft.type = ranked[0].id;
    draft.typeStatus = '';
  } catch (err) {
    if (draft.tagToken !== token || err instanceof models.StaleError) return;
    draft.typeStatus = `Detection failed: ${err.message}`;
  }
  if (draft === currentDraft && $('#typeSuggest')) form.syncType();
}

// ---------- item detail ----------

async function itemView(id) {
  const item = await db.get('items', id);
  if (!item) { view.innerHTML = `<p>Item not found.</p><a href="#/">Back</a>`; return; }
  const outfits = (await db.getAll('outfits')).filter(o => o.itemIds.includes(id));
  const draft = { ...item, colourSuggestions: [], typeSuggestions: [] };
  view.innerHTML = `<div class="topbar">
      <a class="back grow" href="#/">‹ Wardrobe</a>
      <button class="btn danger" id="del">Delete</button><button class="btn primary" id="save">Save</button>
    </div>` + itemForm(draft, {
    photoHtml: `<img class="photo" id="photo" src="${blobUrl(item.photo)}" alt="">
      ${item.original ? '<button class="chip" id="toggleOrig" style="margin-top:8px">Show original photo</button>' : ''}`,
    extra: outfits.length ? `<h2>In outfits</h2><div class="chips wrap">${outfits.map(o =>
      `<a class="chip" href="#/outfit/${o.id}">${esc(o.name || 'Outfit')}</a>`).join('')}</div>` : '',
  });
  bindItemForm(draft);
  $('#toggleOrig')?.addEventListener('click', e => {
    const orig = $('#photo').src === blobUrl(item.original);
    $('#photo').src = blobUrl(orig ? item.photo : item.original);
    e.target.textContent = orig ? 'Show original photo' : 'Show cut-out';
  });
  $('#save').addEventListener('click', async () => {
    await db.put('items', toItem(draft));
    toast('Saved');
    history.back();
  });
  $('#del').addEventListener('click', async () => {
    if (!confirm('Delete this item? It will also be removed from outfits.')) return;
    await db.del('items', id);
    await forgetInTrips({ itemId: id });
    for (const o of outfits) await db.put('outfits', { ...o, itemIds: o.itemIds.filter(x => x !== id) });
    toast('Deleted');
    location.hash = '#/';
  });
}

// ---------- outfits ----------

async function outfitsView() {
  const [outfits, items] = await Promise.all([db.getAll('outfits'), db.getAll('items')]);
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  outfits.sort((a, b) => b.createdAt - a.createdAt);
  view.innerHTML = `
    <div class="row"><h1 class="grow">Outfits</h1><a class="btn primary" href="#/outfit/new">+ New</a></div>
    ${outfits.length ? outfits.map(o => {
      const its = o.itemIds.map(id => byId[id]).filter(Boolean);
      return `<a class="outfit" href="#/outfit/${o.id}">
        <strong>${esc(o.name || 'Untitled outfit')}</strong> <span class="muted">· ${its.length} items</span>
        <div class="thumbs">${its.map(i => `<img src="${blobUrl(i.thumb)}" alt="">`).join('')}</div></a>`;
    }).join('') : `<div class="empty"><div class="big">✨</div>
      <p>${items.length ? 'No outfits yet. Combine a few items into one.' : 'Add some clothes first, then combine them here.'}</p></div>`}`;
}

// One carousel per layer; the centred slot of each row is the outfit. Slot 0 of every row is "none".
const LAYERS = [
  { key: 'outer', label: 'Outerwear', groups: ['Outerwear'] },
  { key: 'top', label: 'Tops', groups: ['Tops'] },
  { key: 'bottom', label: 'Bottoms', groups: ['Bottoms', 'Full body'] },
  { key: 'shoes', label: 'Shoes', groups: ['Shoes'] },
  { key: 'acc', label: 'Accessories', groups: ['Accessories'] },
];
const NEW_OUTFIT_STARTS_WITH = ['top', 'bottom', 'shoes']; // other layers start on "none"
const OPTIONAL_LAYERS = ['outer', 'acc']; // hidden unless switched on, so the main rows get bigger pictures

// mix: { trip, itemIds: Set } — new outfit from a trip's packing list only; saving returns to the trip.
async function outfitView(id, mix = null) {
  let items = (await db.getAll('items')).sort((a, b) => b.createdAt - a.createdAt);
  if (mix) items = items.filter(i => mix.itemIds.has(i.id));
  const rows = LAYERS.map(l => ({ ...l, items: items.filter(i => l.groups.includes(typeById[i.type]?.group)) }));
  const key = mix ? `mix:${mix.trip.id}` : id;
  const back = mix ? `#/trip/${mix.trip.id}` : '#/outfits';
  if (builder?.key !== key) {
    const o = id === 'new' ? null : await db.get('outfits', id);
    if (id !== 'new' && !o) { view.innerHTML = `<p>Outfit not found.</p><a href="#/outfits">Back</a>`; return; }
    const picks = Object.fromEntries(rows.map(r => [r.key,
      o ? r.items.find(i => o.itemIds.includes(i.id))?.id ?? null
        : NEW_OUTFIT_STARTS_WITH.includes(r.key) ? r.items[0]?.id ?? null : null]));
    const show = Object.fromEntries(OPTIONAL_LAYERS.map(k => [k, !!picks[k]]));
    builder = { key, id: o?.id ?? null, name: o?.name ?? '', createdAt: o?.createdAt ?? Date.now(), picks, show };
  }
  const b = builder;
  const visible = r => !OPTIONAL_LAYERS.includes(r.key) || b.show[r.key];

  view.innerHTML = `
    <div class="topbar">
      <a class="back" href="${back}">‹ ${mix ? esc(mix.trip.name || 'Trip') : 'Outfits'}</a>
      ${b.id ? '<button class="btn danger" id="odel">Delete</button>' : ''}
      <button class="btn primary" id="osave">Save</button>
    </div>
    ${mix ? '<p class="muted">Only items on the packing list are shown.</p>' : ''}
    <input type="text" id="oname" placeholder="Outfit name, e.g. Friday office" value="${esc(b.name)}">
    <div class="chips" id="layerToggles"><button class="chip${b.onMe ? ' on' : ''}" data-v="me">${b.onMe ? '✓' : '👤'} On me</button>${
      rows.filter(r => OPTIONAL_LAYERS.includes(r.key)).map(r =>
      `<button class="chip${b.show[r.key] ? ' on' : ''}" data-v="${r.key}">${b.show[r.key] ? '✓' : '+'} ${r.label}</button>`).join('')}</div>
    ${b.onMe ? '<div id="dollBox"></div>' : rows.filter(visible).map(r => `
      <div class="layer">
        <div class="layer-label">${r.label}</div>
        <div class="carousel" data-layer="${r.key}">
          <button class="slot none" data-id=""><span>None</span></button>
          ${r.items.map(i => `<button class="slot" data-id="${i.id}"><img src="${blobUrl(i.thumb)}" alt="${esc(itemTitle(i))}"></button>`).join('')}
        </div>
      </div>`).join('')}`;

  // size the slots so the visible rows fill the screen between the toggles and the tab bar
  const cars = $$('.carousel');
  if (cars.length) {
    window.scrollTo(0, 0);
    const layers = $$('.layer'), slot = cars[0].querySelector('.slot');
    const perRow = layers[1] ? layers[1].offsetTop - layers[0].offsetTop : layers[0].offsetHeight;
    const overhead = perRow - slot.offsetHeight; // label, padding and gap around a slot
    const room = document.querySelector('.tabs').getBoundingClientRect().top - layers[0].getBoundingClientRect().top - 6;
    const w = Math.floor(Math.max(48, Math.min(200, (room / cars.length - overhead) / 1.2)));
    cars.forEach(c => c.style.setProperty('--slot-w', `${w}px`));
  }

  // center the slot of each row's current pick, then keep picks in sync with scrolling
  for (const car of cars) {
    const key = car.dataset.layer;
    const slots = [...car.children];
    const centreOn = (slot, behavior = 'instant') =>
      car.scrollTo({ left: slot.offsetLeft - (car.clientWidth - slot.offsetWidth) / 2, behavior });
    const nearest = () => {
      const mid = car.scrollLeft + car.clientWidth / 2;
      return slots.reduce((best, s) => Math.abs(s.offsetLeft + s.offsetWidth / 2 - mid)
        < Math.abs(best.offsetLeft + best.offsetWidth / 2 - mid) ? s : best);
    };
    const mark = () => {
      const n = nearest();
      slots.forEach(s => s.classList.toggle('on', s === n));
      b.picks[key] = n.dataset.id || null;
    };
    centreOn(slots.find(s => s.dataset.id === (b.picks[key] ?? '')) ?? slots[0]);
    mark();
    let raf;
    car.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(mark); });
    car.addEventListener('click', e => { const s = e.target.closest('.slot'); if (s) centreOn(s, 'smooth'); });
  }

  if (b.onMe) await dollView($('#dollBox'), rows.filter(visible).map(r => ({ layer: r.key, item: r.items.find(i => i.id === b.picks[r.key]) })));

  $('#oname').addEventListener('input', e => { b.name = e.target.value; });
  $('#layerToggles').addEventListener('click', e => {
    const t = e.target.closest('.chip'); if (!t) return;
    const k = t.dataset.v;
    if (k === 'me') { b.onMe = !b.onMe; return outfitView(id, mix); }
    b.show[k] = !b.show[k];
    if (b.show[k] && !b.picks[k]) b.picks[k] = rows.find(r => r.key === k).items[0]?.id ?? null;
    outfitView(id, mix);
  });
  $('#osave').addEventListener('click', async () => {
    const itemIds = rows.filter(visible).map(r => b.picks[r.key]).filter(Boolean);
    if (!itemIds.length) return toast('Pick at least one item');
    await db.put('outfits', { id: b.id ?? db.newId(), name: b.name.trim(), createdAt: b.createdAt, itemIds });
    builder = null;
    toast('Outfit saved');
    location.hash = back;
  });
  $('#odel')?.addEventListener('click', async () => {
    if (!confirm('Delete this outfit? The clothes stay in your wardrobe.')) return;
    await db.del('outfits', b.id);
    await forgetInTrips({ outfitId: b.id });
    builder = null;
    location.hash = '#/outfits';
  });
}

// ---------- on me (paper doll) ----------

const DRAW_ORDER = ['bottom', 'shoes', 'top', 'outer', 'acc']; // bottom to top
const arts = new Map(); // item id -> Promise of { url, w, h, alpha(), rowWidth() }
function artFor(d, item) {
  if (!arts.has(item.id)) {
    const p = d.itemArt(item).then(a => ({ ...a, url: URL.createObjectURL(a.blob) }));
    p.catch(() => arts.delete(item.id));
    arts.set(item.id, p);
  }
  return arts.get(item.id);
}

// The user's photo wearing picks ([{ layer, item }]). Drag an item to move it, pinch to resize, double-tap
// to put it back. Adjustments are saved on the item, so they apply in every outfit.
async function dollView(box, picks) {
  const me = await db.get('settings', 'me');
  if (!me) {
    box.innerHTML = `<div class="empty"><div class="big">👤</div><p>Add a full-length photo of yourself in
      <a href="#/settings">Settings</a> to see your outfits on you.</p></div>`;
    return;
  }
  const d = await doll();
  const worn = picks.filter(p => p.item).sort((a, b) => DRAW_ORDER.indexOf(a.layer) - DRAW_ORDER.indexOf(b.layer));
  const art = await Promise.all(worn.map(p => artFor(d, p.item)));
  const fits = worn.map(p => ({ dx: 0, dy: 0, s: 1, ...p.item.fit }));
  const { W, H } = me.pose;
  const boxes = i => d.place(me.pose, art[i], worn[i].layer, worn[i].item.type, fits[i]);
  box.innerHTML = `<div class="doll" style="aspect-ratio:${W}/${H}"><img class="me" src="${blobUrl(me.photo)}" alt="">${
    worn.map((p, i) => boxes(i).map((_, k) => `<img class="worn" data-i="${i}" data-k="${k}" src="${art[i].url}" alt="">`).join('')).join('')}</div>
    <p class="muted small center">${worn.length ? 'Drag an item to move it, pinch to resize, double-tap to put it back.' : 'Pick some items first.'}</p>`;
  const stage = box.querySelector('.doll');
  // as big as fits between the toggles and the tab bar
  const room = document.querySelector('.tabs').getBoundingClientRect().top - stage.getBoundingClientRect().top - 40;
  stage.style.width = `${Math.min(box.clientWidth, Math.max(160, room) * W / H)}px`;
  const els = [...stage.querySelectorAll('.worn')];
  const layout = () => els.forEach(el => {
    const r = boxes(+el.dataset.i)[+el.dataset.k];
    Object.assign(el.style, { left: `${r.x / W * 100}%`, top: `${r.y / H * 100}%`, width: `${r.w / W * 100}%`, height: `${r.h / H * 100}%`,
      transform: r.mirror ? 'scaleX(-1)' : '' });
  });
  layout();

  const sw = d.shoulderWidth(me.pose);
  const toPhoto = e => { const r = stage.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H }; };
  const hit = at => { // topmost item with a visible pixel under the finger
    for (let i = worn.length - 1; i >= 0; i--) {
      for (const r of boxes(i)) {
        let u = (at.x - r.x) / r.w, v = (at.y - r.y) / r.h;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        if (r.mirror) u = 1 - u;
        if (art[i].alpha(Math.floor(u * art[i].w), Math.floor(v * art[i].h)) > 60) return i;
      }
    }
    return -1;
  };
  const pointers = new Map();
  let active = -1, moved = false, start = null, lastTap = { t: 0, i: -1 };
  const select = i => els.forEach(el => el.classList.toggle('sel', +el.dataset.i === i));
  const save = async i => {
    const item = await db.get('items', worn[i].item.id);
    if (!item) return;
    item.fit = { ...fits[i] };
    worn[i].item.fit = item.fit;
    await db.put('items', item);
  };
  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, toPhoto(e));
    if (pointers.size === 1) { active = hit(toPhoto(e)); moved = false; start = { x: e.clientX, y: e.clientY }; select(active); }
  });
  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || active < 0) return;
    const prev = [...pointers.values()], before = pointers.get(e.pointerId), now = toPhoto(e);
    pointers.set(e.pointerId, now);
    const f = fits[active];
    if (pointers.size === 1) {
      f.dx += (now.x - before.x) / sw; f.dy += (now.y - before.y) / sw;
    } else {
      const cur = [...pointers.values()];
      const span = ps => Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      if (span(prev) > 10) f.s = Math.max(0.3, Math.min(3, f.s * span(cur) / span(prev)));
      f.dx += (now.x - before.x) / 2 / sw; f.dy += (now.y - before.y) / 2 / sw; // the pinch centre moves half as far
    }
    moved ||= pointers.size > 1 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8;
    layout();
  });
  const end = e => {
    if (!pointers.delete(e.pointerId) || pointers.size || active < 0) return;
    const i = active;
    if (moved) save(i);
    else if (Date.now() - lastTap.t < 350 && lastTap.i === i) { // double-tap: back to where it was placed automatically
      Object.assign(fits[i], { dx: 0, dy: 0, s: 1 });
      layout();
      save(i);
    }
    lastTap = moved ? { t: 0, i: -1 } : { t: Date.now(), i };
    select(-1);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

// ---------- trips ----------
// trip: { id, name, start, end ('YYYY-MM-DD'), days: { date: [outfitId] }, extraItemIds: [], packed: [itemId], createdAt }
// Changes save immediately. Assignments outside the date range are kept (in case the dates change back)
// but ignored for the packing list.

let tripSeg = 'plan'; // which section of a trip is showing: plan | pack | more
const MAX_TRIP_DAYS = 60;

const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); };
const fmtDay = s => parseDate(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtRange = t => t.start === t.end ? fmtDay(t.start) : `${fmtDay(t.start)} – ${fmtDay(t.end)}`;

function tripDays(t) {
  const days = [];
  for (let d = t.start; d <= t.end && days.length < MAX_TRIP_DAYS; d = addDays(d, 1)) days.push(d);
  return days;
}

// Packing list = items of the outfits planned on the trip's days + extras.
function packingList(t, outfitById, itemById) {
  const days = new Map(); // itemId -> number of days it's worn
  for (const d of tripDays(t)) {
    const worn = new Set((t.days[d] ?? []).flatMap(oid => outfitById[oid]?.itemIds ?? []));
    worn.forEach(id => days.set(id, (days.get(id) ?? 0) + 1));
  }
  const ids = new Set([...days.keys(), ...t.extraItemIds].filter(id => itemById[id]));
  const entries = [...ids].map(id => ({ item: itemById[id], days: days.get(id) ?? 0, extra: !days.has(id) }));
  return { ids, entries };
}

const plannedOutfitIds = t => new Set(tripDays(t).flatMap(d => t.days[d] ?? []));

// Saved outfits not planned yet whose items are all on the packing list.
const possibleOutfits = (t, outfits, ids) => {
  const planned = plannedOutfitIds(t);
  return outfits.filter(o => !planned.has(o.id) && o.itemIds.length && o.itemIds.every(id => ids.has(id)));
};

// (tops x bottoms + dresses/jumpsuits) x shoes, from the packed items
function combinations(ids, itemById) {
  const n = { Tops: 0, Bottoms: 0, 'Full body': 0, Shoes: 0 };
  ids.forEach(id => { const g = typeById[itemById[id]?.type]?.group; if (g in n) n[g]++; });
  return (n.Tops * n.Bottoms + n['Full body']) * Math.max(1, n.Shoes);
}

const outfitThumbs = (o, itemById) =>
  o.itemIds.map(id => itemById[id]).filter(Boolean).map(i => `<img src="${blobUrl(i.thumb)}" alt="">`).join('');

// Outfit as big pictures; the name is shown only if it has one. tag/attrs: wrapper element, extra: trailing buttons.
const outfitCard = (o, itemById, { tag = 'div', attrs = '', extra = '' } = {}) => `
  <${tag} class="planned" ${attrs}>
    <div class="pl-main">${o.name ? `<div class="pl-name">${esc(o.name)}</div>` : ''}<div class="thumbs">${outfitThumbs(o, itemById)}</div></div>
    ${extra}
  </${tag}>`;

async function forgetInTrips({ outfitId, itemId }) {
  for (const t of await db.getAll('trips')) {
    let changed = false;
    const drop = (list, x) => { const kept = list.filter(v => v !== x); changed ||= kept.length !== list.length; return kept; };
    if (outfitId) for (const d in t.days) t.days[d] = drop(t.days[d], outfitId);
    if (itemId) { t.extraItemIds = drop(t.extraItemIds, itemId); t.packed = drop(t.packed, itemId); }
    if (changed) await db.put('trips', t);
  }
}

async function tripsView() {
  const [trips, outfits, items] = await Promise.all([db.getAll('trips'), db.getAll('outfits'), db.getAll('items')]);
  const outfitById = Object.fromEntries(outfits.map(o => [o.id, o]));
  const itemById = Object.fromEntries(items.map(i => [i.id, i]));
  const today = isoDate(new Date());
  const upcoming = trips.filter(t => t.end >= today).sort((a, b) => a.start.localeCompare(b.start));
  const past = trips.filter(t => t.end < today).sort((a, b) => b.start.localeCompare(a.start));
  const card = t => {
    const days = tripDays(t), planned = days.filter(d => t.days[d]?.length).length;
    const { ids } = packingList(t, outfitById, itemById);
    return `<a class="outfit" href="#/trip/${t.id}">
      <strong>${esc(t.name || 'Trip')}</strong> <span class="muted">· ${fmtRange(t)}</span>
      <div class="muted small">${days.length} day${days.length > 1 ? 's' : ''} · ${planned} planned · ${ids.size} item${ids.size === 1 ? '' : 's'} to pack</div></a>`;
  };
  view.innerHTML = `
    <div class="topbar"><strong class="title">Trips</strong><button class="btn primary" id="newTrip">+ New</button></div>
    ${trips.length ? upcoming.map(card).join('') + (past.length ? `<h2>Past</h2>${past.map(card).join('')}` : '')
      : `<div class="empty"><div class="big">🧳</div><p>Plan what to wear on each day of a trip, and get a packing list.</p></div>`}`;
  $('#newTrip').addEventListener('click', async () => {
    const start = isoDate(new Date());
    const t = { id: db.newId(), name: '', start, end: addDays(start, 2), days: {}, extraItemIds: [], packed: [], createdAt: Date.now() };
    await db.put('trips', t);
    tripSeg = 'plan';
    location.hash = `#/trip/${t.id}`;
  });
}

async function tripView(id) {
  const [t, outfits, items] = await Promise.all([db.get('trips', id), db.getAll('outfits'), db.getAll('items')]);
  if (!t) { view.innerHTML = `<p>Trip not found.</p><a href="#/trips">Back</a>`; return; }
  outfits.sort((a, b) => b.createdAt - a.createdAt);
  const outfitById = Object.fromEntries(outfits.map(o => [o.id, o]));
  const itemById = Object.fromEntries(items.map(i => [i.id, i]));
  const save = () => db.put('trips', t);

  view.innerHTML = `
    <div class="topbar"><a class="back" href="#/trips">‹ Trips</a><button class="btn danger" id="tdel">Delete</button></div>
    <input type="text" id="tname" placeholder="Trip name, e.g. Lisbon weekend" value="${esc(t.name)}">
    <div class="row dates">
      <label class="grow"><span class="field">From</span><input type="date" id="tstart" value="${t.start}"></label>
      <label class="grow"><span class="field">To</span><input type="date" id="tend" value="${t.end}"></label>
    </div>
    <div class="chips seg" id="tseg"></div>
    <div id="tbody"></div>`;

  const renderSeg = () => {
    const { ids } = packingList(t, outfitById, itemById);
    $('#tseg').innerHTML = [['plan', 'Plan'], ['pack', `Pack · ${ids.size}`], ['more', 'More outfits']]
      .map(([k, l]) => `<button class="chip${tripSeg === k ? ' on' : ''}" data-v="${k}">${l}</button>`).join('');
  };
  const renderBody = () => {
    renderSeg();
    ({ plan: renderPlan, pack: renderPack, more: renderMore })[tripSeg]();
  };

  // --- plan: one row per day, outfits picked from the saved ones
  const renderPlan = () => {
    const days = tripDays(t);
    $('#tbody').innerHTML = (outfits.length ? '' : `<div class="notice">You have no outfits yet. Create some in the
        <a href="#/outfits">Outfits</a> tab, then plan them here.</div>`)
      + days.map(d => `
        <div class="day">
          <div class="day-head"><strong>${fmtDay(d)}</strong>${outfits.length ? `<button class="chip" data-add="${d}">+ Outfit</button>` : ''}</div>
          ${(t.days[d] ?? []).filter(oid => outfitById[oid]).map(oid => outfitCard(outfitById[oid], itemById,
            { extra: `<button class="x" data-rm="${d}|${oid}" aria-label="Remove">×</button>` })).join('')}
        </div>`).join('')
      + ((parseDate(t.end) - parseDate(t.start)) / 864e5 + 1 > MAX_TRIP_DAYS
        ? `<p class="muted small">Only the first ${MAX_TRIP_DAYS} days are shown.</p>` : '');
  };

  // --- pack: items of the planned outfits + extras, tick off what's packed
  const renderPack = () => {
    const { entries } = packingList(t, outfitById, itemById);
    const packed = new Set(t.packed);
    const done = entries.filter(e => packed.has(e.item.id)).length;
    const groupOf = e => typeById[e.item.type]?.group ?? 'Unsorted';
    const groups = [...GROUPS, 'Unsorted'].map(g => [g, entries.filter(e => groupOf(e) === g)]).filter(([, es]) => es.length);
    $('#tbody').innerHTML = (entries.length ? `
        <div class="row"><strong class="grow">${done} of ${entries.length} packed</strong></div>
        <progress value="${done}" max="${entries.length}"></progress>
        ${groups.map(([g, es]) => `<h2>${g}</h2>${es.map(e => `
          <label class="pack-row${packed.has(e.item.id) ? ' done' : ''}">
            <input type="checkbox" data-pack="${e.item.id}"${packed.has(e.item.id) ? ' checked' : ''}>
            <img src="${blobUrl(e.item.thumb)}" alt="">
            <span class="grow">${esc(itemTitle(e.item))}<br>
              <small class="muted">${e.extra ? 'extra' : `${e.days} day${e.days > 1 ? 's' : ''}`}</small></span>
            ${e.extra ? `<button class="x" data-unextra="${e.item.id}" aria-label="Remove">×</button>` : ''}
          </label>`).join('')}`).join('')}`
      : `<p class="muted">Plan outfits for your days and their clothes appear here. You can also add extra items.</p>`)
      + `<button class="btn block" id="addExtra" style="margin-top:14px">+ Add item</button>`;
  };

  // --- more: saved outfits the suitcase allows, and mix & match from packed items
  const renderMore = () => {
    const { ids } = packingList(t, outfitById, itemById);
    const possible = possibleOutfits(t, outfits, ids);
    const n = combinations(ids, itemById);
    $('#tbody').innerHTML = `
      <h2>Also possible with your packing list</h2>
      ${possible.length ? possible.map(o => outfitCard(o, itemById,
          { extra: `<button class="chip" data-plan="${o.id}">+ Plan</button>` })).join('')
        : `<p class="muted">${ids.size ? 'No other saved outfit is made only of packed items.' : 'Nothing packed yet.'}</p>`}
      <div class="panel">
        <strong>Mix &amp; match</strong>
        <p class="muted">${n ? `Your packed tops, bottoms and shoes make ${n} combination${n > 1 ? 's' : ''}.`
          : 'Pack some tops and bottoms (or a dress) to see combinations.'}</p>
        <a class="btn block${n ? '' : ' disabled'}" ${n ? `href="#/mix/${t.id}"` : ''}>Try combinations</a>
      </div>`;
  };

  // --- events
  $('#tname').addEventListener('input', e => { t.name = e.target.value; save(); });
  const onDates = () => {
    const s = $('#tstart').value, e = $('#tend').value;
    if (!s || !e) return;
    t.start = s;
    t.end = e < s ? s : e;
    $('#tend').value = t.end;
    save();
    renderBody();
  };
  $('#tstart').addEventListener('change', onDates);
  $('#tend').addEventListener('change', onDates);
  $('#tseg').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    tripSeg = b.dataset.v;
    renderBody();
  });
  $('#tdel').addEventListener('click', async () => {
    if (!confirm('Delete this trip? Your clothes and outfits stay.')) return;
    await db.del('trips', t.id);
    location.hash = '#/trips';
  });
  $('#tbody').addEventListener('click', e => {
    const el = e.target.closest('[data-add],[data-rm],[data-unextra],[data-plan],#addExtra');
    if (!el) return;
    if (el.dataset.add) {
      e.preventDefault();
      pickOutfit(el.dataset.add);
    } else if (el.dataset.rm) {
      const [d, oid] = el.dataset.rm.split('|');
      t.days[d] = (t.days[d] ?? []).filter(x => x !== oid);
      save(); renderBody();
    } else if (el.dataset.unextra) {
      e.preventDefault(); // inside a <label>: don't toggle the checkbox
      t.extraItemIds = t.extraItemIds.filter(x => x !== el.dataset.unextra);
      save(); renderBody();
    } else if (el.dataset.plan) {
      pickDay(el.dataset.plan);
    } else if (el.id === 'addExtra') {
      pickExtras();
    }
  });
  $('#tbody').addEventListener('change', e => {
    const id = e.target.dataset.pack; if (!id) return;
    t.packed = e.target.checked ? [...new Set([...t.packed, id])] : t.packed.filter(x => x !== id);
    save();
    renderBody();
  });

  const pickOutfit = day => openSheet(`Outfit for ${fmtDay(day)}`, outfits.map(o =>
      outfitCard(o, itemById, { tag: 'button', attrs: `data-v="${o.id}"` })).join(''), oid => {
    t.days[day] = [...new Set([...(t.days[day] ?? []), oid])];
    save(); renderBody();
    return true;
  });

  const pickDay = oid => openSheet(outfitById[oid].name ? `Plan “${esc(outfitById[oid].name)}” on…` : 'Plan on…', tripDays(t).map(d => `
      <button class="planned pick" data-v="${d}"><span class="grow">${fmtDay(d)}</span>
        <small class="muted">${(t.days[d] ?? []).filter(x => outfitById[x]).length || 'nothing'} planned</small></button>`).join(''), d => {
    t.days[d] = [...new Set([...(t.days[d] ?? []), oid])];
    save(); renderBody();
    toast(`Planned on ${fmtDay(d)}`);
    return true;
  });

  const pickExtras = () => {
    const inOutfits = new Set(packingList({ ...t, extraItemIds: [] }, outfitById, itemById).ids);
    const choices = items.filter(i => !inOutfits.has(i.id)).sort((a, b) => b.createdAt - a.createdAt);
    const extra = new Set(t.extraItemIds);
    openSheet('Add to the packing list', choices.length
      ? `<div class="grid">${choices.map(i => itemCard(i, { selected: extra.has(i.id) })).join('')}</div>`
      : '<p class="muted">Every item is already on the list.</p>', (iid, el) => {
      extra.has(iid) ? extra.delete(iid) : extra.add(iid);
      el.classList.toggle('sel', extra.has(iid));
      t.extraItemIds = [...extra];
      save(); renderBody();
      return false; // keep the sheet open to pick several
    }, { done: true });
  };

  renderBody();
}

// Bottom sheet with a list of choices. onPick(value, element) returns true to close.
function openSheet(title, bodyHtml, onPick, { done = false } = {}) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}">
    <div class="row sheet-head"><strong class="grow">${title}</strong>
      <button class="btn${done ? ' primary' : ''}" data-close>${done ? 'Done' : 'Cancel'}</button></div>
    <div class="sheet-body">${bodyHtml}</div></div>`;
  const close = () => sheet.remove();
  sheet.addEventListener('click', e => {
    if (e.target === sheet || e.target.closest('[data-close]')) return close();
    const el = e.target.closest('[data-v],[data-id]');
    if (el && onPick(el.dataset.v ?? el.dataset.id, el)) close();
  });
  window.addEventListener('hashchange', close, { once: true });
  document.body.append(sheet);
}

async function mixView(tripId) {
  const [t, outfits, items] = await Promise.all([db.get('trips', tripId), db.getAll('outfits'), db.getAll('items')]);
  if (!t) { location.replace('#/trips'); return; }
  const { ids } = packingList(t, Object.fromEntries(outfits.map(o => [o.id, o])), Object.fromEntries(items.map(i => [i.id, i])));
  return outfitView('new', { trip: t, itemIds: ids });
}

// ---------- settings / backup ----------

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function exportBackup() {
  const [items, outfits, trips, me] = await Promise.all([db.getAll('items'), db.getAll('outfits'), db.getAll('trips'), db.get('settings', 'me')]);
  const data = {
    app: 'wardrobe', version: 3, exportedAt: new Date().toISOString(), outfits, trips,
    items: await Promise.all(items.map(async i => ({
      ...i, photo: await blobToDataUrl(i.photo), thumb: await blobToDataUrl(i.thumb),
      original: i.original ? await blobToDataUrl(i.original) : null,
      cutout: i.cutout ? await blobToDataUrl(i.cutout) : null,
    }))),
    me: me ? { ...me, photo: await blobToDataUrl(me.photo) } : null,
  };
  const name = `wardrobe-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Wardrobe backup' }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'wardrobe') throw new Error('Not a wardrobe backup');
  const toBlob = async u => (await fetch(u)).blob();
  for (const i of data.items) {
    await db.put('items', { ...i, photo: await toBlob(i.photo), thumb: await toBlob(i.thumb), original: i.original ? await toBlob(i.original) : null,
      cutout: i.cutout ? await toBlob(i.cutout) : null });
  }
  if (data.me) await db.put('settings', { ...data.me, photo: await toBlob(data.me.photo) }); // v3+
  for (const o of data.outfits) await db.put('outfits', o);
  for (const t of data.trips ?? []) await db.put('trips', t); // v1 backups have no trips
  return data.items.length;
}

const meWarning = "⚠️ Couldn't find your whole body (shoulders, hips and feet) in this photo. Items are placed roughly; drag them into place, or try a full-length photo.";

async function settingsView() {
  const [items, outfits, me] = await Promise.all([db.getAll('items'), db.getAll('outfits'), db.get('settings', 'me')]);
  const hasModel = await models.modelsDownloaded().catch(() => false);
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  const mb = n => (n / 1e6).toFixed(0) + ' MB';
  view.innerHTML = `
    <h1>Settings</h1>
    <div class="panel">
      <strong>Your data</strong>
      <p class="muted">${items.length} items, ${outfits.length} outfits. Stored only on this phone${est ? `, using ${mb(est.usage)}` : ''}.
      ${persisted ? '' : '<br>⚠️ The browser may clear it if storage runs low, so export a backup now and then.'}</p>
      <div class="row">
        <button class="btn grow" id="exp">Export backup</button>
        <label class="btn grow">Import backup<input type="file" accept="application/json,.json" hidden id="imp"></label>
      </div>
      <div class="status" id="bstatus"></div>
    </div>
    <div class="panel">
      <strong>Me</strong>
      <p class="muted">A full-length photo of you, to see outfits on you (Outfits → On me). It stays on this phone.</p>
      ${me ? `<img class="me-thumb" src="${blobUrl(me.photo)}" alt="Your photo">` : ''}
      <div class="row">
        <label class="btn grow">${me ? 'Change photo' : 'Add photo'}<input type="file" accept="image/*" hidden id="mePhoto"></label>
        ${me ? '<button class="btn" id="meDel">Remove</button>' : ''}
      </div>
      <div class="status" id="meStatus">${me && !me.pose.ok ? meWarning : ''}</div>
      <p class="muted small">Best: standing straight, facing the camera, head to feet in the picture, arms a little away
      from the body, plain background and fitted clothes.</p>
    </div>
    <div class="panel">
      <strong>AI helpers</strong>
      <p class="muted">${hasModel ? `Type detection and tap-to-select are ready (${await models.totalMB()} MB, work offline).`
        : 'Downloading (see the bar at the top)…'}<br>Running on: ${await models.backendLabel()}</p>
      ${await models.gpuAvailable() ? `<label class="row"><input type="checkbox" id="gpu"${models.gpuState() === 'on' ? ' checked' : ''}>
        <span class="grow">Use the graphics chip for tap-to-select (experimental)</span></label>
        <p class="muted small">Can be faster, but on some phones it gives wrong outlines or even freezes the phone
        while it's being checked. If that happens, restart the phone and switch this off.</p>
        ${models.gpuState() === 'failed' ? `<p class="muted small">Switched off automatically on this phone: ${esc(models.gpuFailReason() ?? 'it failed')}.</p>`
          : models.gpuFailReason() && models.gpuState() === 'on' ? `<p class="muted small">${esc(models.gpuFailReason())}</p>` : ''}`
        : '<p class="muted small">This browser has no graphics chip access (WebGPU), so the processor is used.</p>'}
    </div>
    <p class="muted" style="font-size:.8rem">Type detection: OpenAI CLIP ViT-B/32. Tap-to-select: EdgeSAM (Segment Anything).
    On me: MoveNet. All run on-device via onnxruntime-web.</p>`;

  $('#mePhoto').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const status = $('#meStatus');
    try {
      const mb = await models.poseMB();
      status.textContent = mb ? `Getting the body finder ready (one-time, ${mb} MB)…` : 'Finding your shoulders, hips and feet…';
      const bmp = await createImageBitmap(f);
      const photo = fit(bmp, 1600);
      const pose = await (await doll()).detectPose(photo, p => { status.textContent = `Getting the body finder ready (one-time, ${mb} MB)… ${Math.round(p * 100)}%`; });
      await db.put('settings', { id: 'me', photo: await resizeToBlob(photo, 1600, 0.9), pose, createdAt: Date.now() });
      await settingsView();
      if (pose.ok) toast('Photo saved');
    } catch (err) {
      console.error(err);
      status.textContent = `Couldn't use this photo: ${err.message}`;
    }
  });
  $('#meDel')?.addEventListener('click', async () => {
    if (!confirm('Remove your photo?')) return;
    await db.del('settings', 'me');
    settingsView();
  });
  $('#gpu')?.addEventListener('change', e => {
    models.setGpu(e.target.checked);
    location.reload(); // the AI engine is set up once per launch
  });
  $('#exp').addEventListener('click', async () => {
    $('#bstatus').textContent = 'Preparing…';
    try { await exportBackup(); $('#bstatus').textContent = ''; }
    catch (err) { $('#bstatus').textContent = `Export failed: ${err.message}`; }
  });
  $('#imp').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    $('#bstatus').textContent = 'Importing…';
    try { const n = await importBackup(f); toast(`Imported ${n} items`); settingsView(); }
    catch (err) { $('#bstatus').textContent = `Import failed: ${err.message}`; }
  });
}

// ---------- router ----------

async function render() {
  const [, route = '', arg] = location.hash.split('/');
  const tab = { '': 'wardrobe', item: 'wardrobe', add: 'wardrobe', outfits: 'outfits', outfit: 'outfits',
    trips: 'trips', trip: 'trips', mix: 'trips', settings: 'settings' }[route];
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  if (route !== 'outfit' && route !== 'mix') builder = null;
  if (route !== 'add') addQueue = [];
  window.scrollTo(0, 0);
  try {
    if (route === 'item') await itemView(arg);
    else if (route === 'add') await addView();
    else if (route === 'outfits') await outfitsView();
    else if (route === 'outfit') await outfitView(arg);
    else if (route === 'trips') await tripsView();
    else if (route === 'trip') await tripView(arg);
    else if (route === 'mix') await mixView(arg);
    else if (route === 'settings') await settingsView();
    else await wardrobeView();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<h1>Something went wrong</h1><p class="muted">${esc(err.message)}</p>`;
  }
}

types = await loadTypes();
typeById = Object.fromEntries(types.map(t => [t.id, t]));
window.addEventListener('hashchange', render);
render();
prepareModels();
backfillFingerprints();

// Downloads the AI models on first launch, with a progress bar; the app stays usable meanwhile.
async function prepareModels() {
  if (await models.modelsDownloaded().catch(() => false)) return;
  const bar = document.getElementById('modelBar'), text = document.getElementById('modelText');
  const prog = document.getElementById('modelProg'), retry = document.getElementById('modelRetry');
  bar.hidden = false;
  document.body.classList.add('downloading');
  document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px'); // sticky item bar sits below it
  retry.hidden = true;
  prog.hidden = false;
  const mb = await models.missingMB();
  text.textContent = `Preparing AI helpers (one-time, ${mb} MB)…`;
  retry.onclick = prepareModels;
  try {
    await models.ensureModels(p => {
      prog.value = p;
      text.textContent = `Preparing AI helpers (one-time, ${mb} MB)… ${Math.round(p * 100)}%`;
    });
    bar.hidden = true;
    document.body.classList.remove('downloading');
    document.documentElement.style.removeProperty('--bar-h');
    if (location.hash.startsWith('#/settings')) render();
  } catch (err) {
    console.warn(err);
    text.textContent = "AI helpers couldn't download. Check your connection.";
    prog.hidden = true;
    retry.hidden = false;
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    // home-screen apps stay alive in the background: look for updates whenever the app comes back
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
  });
  // a new version took over: reload to run it, but never in the middle of adding/editing something
  const hadController = !!navigator.serviceWorker.controller;
  const busy = () => /^#\/(add|item|outfit\/|mix)/.test(location.hash);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, nothing old is running
    if (!busy()) return location.reload();
    window.addEventListener('hashchange', function later() {
      if (!busy()) { window.removeEventListener('hashchange', later); location.reload(); }
    });
  });
}
