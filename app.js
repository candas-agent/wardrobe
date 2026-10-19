import * as db from './db.js';
import { GROUPS, PALETTE, colourById, loadTypes } from './catalog.js';

const view = document.getElementById('view');
import * as models from './models.js';

const classifier = () => import('./classify.js'); // loaded lazily; onnxruntime itself loads on first use

let types = [], typeById = {};
const filters = { q: '', group: '', colour: '' };
let addQueue = [], addTotal = 0;
let currentDraft = null; // draft shown in the add form; late type results for other drafts are dropped
let builder = null; // outfit being edited: { id, isNew, name, createdAt, picks: { layer: itemId|null } }

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

async function resizeToBlob(bmp, max, quality) {
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/jpeg', quality });
}

// ---------- wardrobe ----------

async function wardrobeView() {
  const items = (await db.getAll('items')).sort((a, b) => b.createdAt - a.createdAt);
  if (!items.length) {
    view.innerHTML = `<h1>Wardrobe</h1>
      <div class="empty"><div class="big">👗</div><p>No clothes yet.</p>
      <a class="btn primary" href="#/add">Add your first item</a></div>`;
    return;
  }
  const colours = PALETTE.filter(c => items.some(i => i.colour === c.id || i.colour2 === c.id));
  view.innerHTML = `
    <h1>Wardrobe <small class="muted">${items.length}</small></h1>
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
});

// ---------- add ----------

async function addView() {
  if (addQueue.length) return addNext();
  view.innerHTML = `
    <h1>Add clothes</h1>
    <p class="muted">Photograph your clothes. If there are several items or a busy background, you can tap the one you want.</p>
    <div class="row" style="margin:16px 0">
      <label class="btn primary grow">📷 Take photo<input type="file" accept="image/*" capture="environment" hidden id="camera"></label>
      <label class="btn grow">🖼️ From gallery<input type="file" accept="image/*" multiple hidden id="gallery"></label>
    </div>`;

  const onFiles = e => {
    addQueue = [...e.target.files];
    addTotal = addQueue.length;
    if (addQueue.length) addNext();
  };
  $('#camera').addEventListener('change', onFiles);
  $('#gallery').addEventListener('change', onFiles);
}

const stageHtml = `
  <canvas class="stage tappable" id="stage"></canvas>
  <div class="status" id="segStatus">Several things in the photo? Tap the item you want.</div>
  <div class="cands" id="cands"></div>`;

async function addNext() {
  const file = addQueue.shift();
  if (!file) return render();
  view.innerHTML = `<h1>Add clothes</h1><p class="status">Reading photo…</p>`;
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    toast("Couldn't read that image");
    return addNext();
  }
  // working copy at storage resolution; segmentation and the cut-out are done on this
  const s = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const work = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  work.getContext('2d').drawImage(bmp, 0, 0, work.width, work.height);
  bmp.close();
  const [photo, thumb] = await Promise.all([resizeToBlob(work, 1280, 0.85), resizeToBlob(work, 400, 0.8)]);
  const draft = {
    id: db.newId(), createdAt: Date.now(), type: '', colour: '', colour2: '', name: '', notes: '',
    photo, thumb, work, points: [], masks: null, maskIdx: 0, cut: null,
  };
  currentDraft = draft;

  const cls = await classifier();
  if (!location.hash.startsWith('#/add')) return; // user navigated away meanwhile

  const pos = addTotal > 1 ? ` <span class="muted">${addTotal - addQueue.length} of ${addTotal}</span>` : '';
  view.innerHTML = `<div class="topbar">
      <strong class="title">Add clothes${pos}</strong>
      <button class="btn" id="skip">Skip</button><button class="btn primary" id="save">Save</button>
    </div>` + itemForm(draft, { photoHtml: stageHtml });
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
      [draft.photo, draft.thumb] = await Promise.all([resizeToBlob(await flat, 1280, 0.85), resizeToBlob(await flat, 400, 0.8)]);
    }
    await db.put('items', toItem(draft));
    navigator.storage?.persist?.(); // ask the browser not to evict our data
    toast('Saved');
    addNext();
  });

  // a tap selects the item under it (replacing any previous selection); tapping the dot again clears it
  stage.addEventListener('click', e => {
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * work.width, y = (e.clientY - r.top) / r.height * work.height;
    const [p] = draft.points;
    if (p && Math.hypot(p.x - x, p.y - y) < dotRadius(stage) * 1.8) return resetSelection(draft, form, cls);
    draft.points = [{ x, y, include: true }];
    runSegment(draft, form);
  });

  retag(draft, form, cls, work, true);
  // start the heavy SAM encoder in the background so the first tap feels instant
  draft.enc = seg().then(m => m.encode(work));
  draft.enc.catch(() => { draft.enc = null; });
}

function resetSelection(draft, form, cls) {
  Object.assign(draft, { points: [], masks: null, cut: null });
  $('#cands').innerHTML = '';
  $('#segStatus').textContent = 'Several things in the photo? Tap the item you want.';
  drawStage(draft);
  retag(draft, form, cls, draft.work, true);
}

const dotRadius = stage => Math.max(8, stage.width / 70);

const seg = () => import('./segment.js');

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
  status.textContent = draft.enc ? 'Finding the item…' : 'Loading…';
  drawStage(draft);
  try {
    const m = await seg();
    draft.enc ??= m.encode(draft.work);
    const enc = await draft.enc;
    const points = draft.points;
    const res = await m.segment(enc, points);
    if (draft !== currentDraft || points !== draft.points) return; // a newer tap replaced this one
    draft.masks = res.masks;
    draft.maskIdx = res.best;
    status.textContent = 'Pick the best outline below. Tap elsewhere to choose another item, or the dot to undo.';
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
    b.setAttribute('aria-label', ['Smaller', 'Medium', 'Larger'][i] + ' outline');
    const c = document.createElement('canvas');
    if (mask.bbox) {
      const cut = m.cutout(draft.work, mask), k = 160 / Math.max(cut.width, cut.height);
      c.width = Math.max(1, Math.round(cut.width * k));
      c.height = Math.max(1, Math.round(cut.height * k));
      c.getContext('2d').drawImage(cut, 0, 0, c.width, c.height);
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
    const ranked = await cls.classifyType(source);
    if (draft.tagToken !== token) return;
    draft.typeSuggestions = ranked.slice(0, 3);
    if (!draft.typeManual) draft.type = ranked[0].id;
    draft.typeStatus = '';
  } catch (err) {
    if (draft.tagToken !== token) return;
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
    <div class="row"><h1 class="grow">Outfits</h1><a class="btn primary" href="#/outfit/new">＋ New</a></div>
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

async function outfitView(id) {
  const items = (await db.getAll('items')).sort((a, b) => b.createdAt - a.createdAt);
  const rows = LAYERS.map(l => ({ ...l, items: items.filter(i => l.groups.includes(typeById[i.type]?.group)) }));
  if (builder?.id !== id) {
    const o = id === 'new' ? null : await db.get('outfits', id);
    if (id !== 'new' && !o) { view.innerHTML = `<p>Outfit not found.</p><a href="#/outfits">Back</a>`; return; }
    const picks = Object.fromEntries(rows.map(r => [r.key,
      o ? r.items.find(i => o.itemIds.includes(i.id))?.id ?? null
        : NEW_OUTFIT_STARTS_WITH.includes(r.key) ? r.items[0]?.id ?? null : null]));
    builder = { id, isNew: !o, name: o?.name ?? '', createdAt: o?.createdAt ?? Date.now(), picks };
  }
  const b = builder;

  view.innerHTML = `
    <div class="topbar">
      <a class="back" href="#/outfits">‹ Outfits</a>
      ${b.isNew ? '' : '<button class="btn danger" id="odel">Delete</button>'}
      <button class="btn primary" id="osave">Save</button>
    </div>
    <input type="text" id="oname" placeholder="Outfit name, e.g. Friday office" value="${esc(b.name)}">
    ${rows.map(r => `
      <div class="layer">
        <div class="layer-label">${r.label}</div>
        <div class="carousel" data-layer="${r.key}">
          <button class="slot none" data-id=""><span>None</span></button>
          ${r.items.map(i => `<button class="slot" data-id="${i.id}"><img src="${blobUrl(i.thumb)}" alt="${esc(itemTitle(i))}"></button>`).join('')}
        </div>
      </div>`).join('')}`;

  // center the slot of each row's current pick, then keep picks in sync with scrolling
  for (const car of $$('.carousel')) {
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

  $('#oname').addEventListener('input', e => { b.name = e.target.value; });
  $('#osave').addEventListener('click', async () => {
    const itemIds = LAYERS.map(l => b.picks[l.key]).filter(Boolean);
    if (!itemIds.length) return toast('Pick at least one item');
    await db.put('outfits', { id: b.isNew ? db.newId() : b.id, name: b.name.trim(), createdAt: b.createdAt, itemIds });
    builder = null;
    toast('Outfit saved');
    location.hash = '#/outfits';
  });
  $('#odel')?.addEventListener('click', async () => {
    if (!confirm('Delete this outfit? The clothes stay in your wardrobe.')) return;
    await db.del('outfits', b.id);
    builder = null;
    location.hash = '#/outfits';
  });
}

// ---------- settings / backup ----------

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function exportBackup() {
  const [items, outfits] = await Promise.all([db.getAll('items'), db.getAll('outfits')]);
  const data = {
    app: 'wardrobe', version: 1, exportedAt: new Date().toISOString(), outfits,
    items: await Promise.all(items.map(async i => ({
      ...i, photo: await blobToDataUrl(i.photo), thumb: await blobToDataUrl(i.thumb),
      original: i.original ? await blobToDataUrl(i.original) : null,
    }))),
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
    await db.put('items', { ...i, photo: await toBlob(i.photo), thumb: await toBlob(i.thumb), original: i.original ? await toBlob(i.original) : null });
  }
  for (const o of data.outfits) await db.put('outfits', o);
  return data.items.length;
}

async function settingsView() {
  const [items, outfits] = await Promise.all([db.getAll('items'), db.getAll('outfits')]);
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
      <strong>AI helpers</strong>
      <p class="muted">${hasModel ? `Type detection and tap-to-select are ready (${models.TOTAL_MB} MB, work offline).`
        : 'Downloading (see the bar at the top)…'}</p>
    </div>
    </div>
    <p class="muted" style="font-size:.8rem">Type detection: OpenAI CLIP ViT-B/32. Tap-to-select: SlimSAM (Segment Anything). Both run on-device via onnxruntime-web.</p>`;

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
  const tab = { '': 'wardrobe', item: 'wardrobe', add: 'add', outfits: 'outfits', outfit: 'outfits', settings: 'settings' }[route];
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  if (route !== 'outfit') builder = null;
  if (route !== 'add') addQueue = [];
  window.scrollTo(0, 0);
  try {
    if (route === 'item') await itemView(arg);
    else if (route === 'add') await addView();
    else if (route === 'outfits') await outfitsView();
    else if (route === 'outfit') await outfitView(arg);
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
  text.textContent = `Preparing AI helpers (one-time, ${models.TOTAL_MB} MB)…`;
  retry.onclick = prepareModels;
  try {
    await models.ensureModels(p => {
      prog.value = p;
      text.textContent = `Preparing AI helpers (one-time, ${models.TOTAL_MB} MB)… ${Math.round(p * 100)}%`;
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
