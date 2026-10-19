import * as db from './db.js';
import { GROUPS, PALETTE, colourById, loadTypes } from './catalog.js';

const view = document.getElementById('view');
import * as models from './models.js';

const classifier = () => import('./classify.js'); // loaded lazily; onnxruntime itself loads on first use

let types = [], typeById = {};
const filters = { q: '', group: '', colour: '' };
let addQueue = [];
let currentDraft = null; // draft shown in the add form; late type results for other drafts are dropped
let builder = null; // outfit being edited: { id, name, createdAt, itemIds: Set, group }

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
    <div class="actions" id="formActions">${saveLabel}</div>`;
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

const modelPanel = () => `<div class="panel" id="modelPanel">
  <strong>AI helpers</strong>
  <p class="muted">Type detection and tap-to-select need a one-time ${models.TOTAL_MB} MB download (Wi-Fi recommended).
  After that they work offline. Colour detection works without it.</p>
  <button class="btn block" id="dl">Download models</button>
  <progress id="dlProg" value="0" max="1" hidden></progress>
  <div class="status" id="dlStatus"></div>
</div>`;

async function addView() {
  if (addQueue.length) return addNext();
  const hasModel = await models.modelsDownloaded().catch(() => false);
  view.innerHTML = `
    <h1>Add clothes</h1>
    <p class="muted">Photograph your clothes. If there are several items or a busy background, you can tap the one you want.</p>
    <div class="row" style="margin:16px 0">
      <label class="btn primary grow">📷 Take photo<input type="file" accept="image/*" capture="environment" hidden id="camera"></label>
      <label class="btn grow">🖼️ From gallery<input type="file" accept="image/*" multiple hidden id="gallery"></label>
    </div>
    ${hasModel ? '' : modelPanel()}`;

  const onFiles = e => {
    addQueue = [...e.target.files];
    if (addQueue.length) addNext();
  };
  $('#camera').addEventListener('change', onFiles);
  $('#gallery').addEventListener('change', onFiles);
  $('#dl')?.addEventListener('click', () => downloadModels($('#dl'), $('#dlProg'), $('#dlStatus')));
}

async function downloadModels(btn, prog, status) {
  btn.disabled = true;
  prog.hidden = false;
  status.textContent = 'Downloading…';
  try {
    await models.downloadModels(p => { prog.value = p; status.textContent = `Downloading… ${Math.round(p * 100)}%`; });
    status.textContent = 'Ready. Type detection and tap-to-select are on.';
    btn.hidden = true;
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
    btn.disabled = false;
  }
}

const stageHtml = hasModel => `
  <canvas class="stage" id="stage"></canvas>
  ${hasModel ? `
  <div class="row stage-tools">
    <div class="chips" id="mode">
      <button class="chip on" data-v="1">＋ Add area</button><button class="chip" data-v="0">− Remove area</button>
    </div>
    <button class="chip" id="reset" hidden>Reset</button>
  </div>
  <div class="status" id="segStatus">Tap the item to cut it out, or skip this if it's the only thing in the photo.</div>
  <div class="cands" id="cands"></div>` : ''}`;

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
    photo, thumb, work, points: [], masks: null, maskIdx: 0, cut: null, include: true,
  };
  currentDraft = draft;

  const [cls, hasModel] = await Promise.all([classifier(), models.modelsDownloaded().catch(() => false)]);
  if (!location.hash.startsWith('#/add')) return; // user navigated away meanwhile

  const left = addQueue.length;
  view.innerHTML = `<h1>Add clothes</h1>` + itemForm(draft, {
    photoHtml: stageHtml(hasModel),
    saveLabel: `<button class="btn" id="skip">Skip</button>
      <button class="btn primary" id="save">${left ? `Save & next (${left} left)` : 'Save'}</button>`,
  });
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

  if (hasModel) {
    stage.classList.add('tappable');
    stage.addEventListener('click', e => {
      const r = stage.getBoundingClientRect();
      draft.points.push({ x: (e.clientX - r.left) / r.width * work.width, y: (e.clientY - r.top) / r.height * work.height, include: draft.include });
      runSegment(draft, form);
    });
    $('#mode').addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (!b) return;
      draft.include = b.dataset.v === '1';
      $$('#mode .chip').forEach(c => c.classList.toggle('on', c === b));
    });
    $('#reset').addEventListener('click', () => {
      Object.assign(draft, { points: [], masks: null, cut: null });
      $('#cands').innerHTML = '';
      $('#reset').hidden = true;
      $('#segStatus').textContent = 'Tap the item to cut it out.';
      drawStage(draft);
      retag(draft, form, cls, draft.work, true);
    });
  }

  retag(draft, form, cls, work, hasModel);
  // start the heavy SAM encoder in the background so the first tap feels instant
  if (hasModel) draft.enc = seg().then(m => m.encode(work));
}

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
  const r = Math.max(8, stage.width / 70);
  for (const p of draft.points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.include ? '#2e9d4a' : '#d23a3a';
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
    const points = [...draft.points];
    const res = await m.segment(enc, points);
    if (draft !== currentDraft || points.length !== draft.points.length) return; // a newer tap is in flight
    draft.masks = res.masks;
    draft.maskIdx = res.best;
    $('#reset').hidden = false;
    status.textContent = 'Not quite right? Pick another outline below, or tap again to add or remove areas.';
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
  view.innerHTML = `<a class="back" href="#/">‹ Wardrobe</a>` + itemForm(draft, {
    photoHtml: `<img class="photo" id="photo" src="${blobUrl(item.photo)}" alt="">
      ${item.original ? '<button class="chip" id="toggleOrig" style="margin-top:8px">Show original photo</button>' : ''}`,
    extra: outfits.length ? `<h2>In outfits</h2><div class="chips wrap">${outfits.map(o =>
      `<a class="chip" href="#/outfit/${o.id}">${esc(o.name || 'Outfit')}</a>`).join('')}</div>` : '',
    saveLabel: `<button class="btn danger" id="del">Delete</button><button class="btn primary" id="save">Save</button>`,
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

async function outfitView(id) {
  const items = (await db.getAll('items')).sort((a, b) => b.createdAt - a.createdAt);
  if (builder?.id !== id && !(id === 'new' && builder?.isNew)) {
    const o = id === 'new' ? null : await db.get('outfits', id);
    if (id !== 'new' && !o) { view.innerHTML = `<p>Outfit not found.</p><a href="#/outfits">Back</a>`; return; }
    builder = o
      ? { id: o.id, name: o.name, createdAt: o.createdAt, itemIds: new Set(o.itemIds), q: '', group: '' }
      : { id: 'new', isNew: true, name: '', createdAt: Date.now(), itemIds: new Set(), q: '', group: '' };
  }
  const b = builder;
  const byId = Object.fromEntries(items.map(i => [i.id, i]));

  view.innerHTML = `
    <a class="back" href="#/outfits">‹ Outfits</a>
    <input type="text" id="oname" placeholder="Outfit name, e.g. Friday office" value="${esc(b.name)}">
    <h2>Selected</h2>
    <div class="strip" id="strip"></div>
    <h2>Pick items</h2>
    <input type="search" id="oq" placeholder="Search" value="${esc(b.q)}">
    ${groupChips(b.group)}
    <div class="grid" id="ogrid"></div>
    <div class="actions">
      ${b.isNew ? '' : '<button class="btn danger" id="odel">Delete</button>'}
      <button class="btn primary" id="osave">Save outfit</button>
    </div>`;

  const renderStrip = () => {
    const sel = [...b.itemIds].map(i => byId[i]).filter(Boolean);
    $('#strip').innerHTML = sel.length
      ? sel.map(i => `<img src="${blobUrl(i.thumb)}" data-id="${i.id}" alt="${esc(itemTitle(i))}">`).join('')
      : `<span class="muted" style="align-self:center;padding:0 8px">Tap items below to add them.</span>`;
  };
  const renderGrid = () => {
    const shown = items.filter(i => matches(i, b));
    $('#ogrid').innerHTML = shown.map(i => itemCard(i, { selected: b.itemIds.has(i.id) })).join('')
      || `<p class="muted">Nothing matches.</p>`;
  };
  const toggle = itemId => {
    b.itemIds.has(itemId) ? b.itemIds.delete(itemId) : b.itemIds.add(itemId);
    renderStrip();
    $(`#ogrid [data-id="${itemId}"]`)?.classList.toggle('sel', b.itemIds.has(itemId));
  };

  $('#oname').addEventListener('input', e => { b.name = e.target.value; });
  $('#oq').addEventListener('input', e => { b.q = e.target.value.trim(); renderGrid(); });
  onChips('group', v => { b.group = v; renderGrid(); });
  $('#ogrid').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) toggle(c.dataset.id); });
  $('#strip').addEventListener('click', e => { const i = e.target.closest('img'); if (i) toggle(i.dataset.id); });
  $('#osave').addEventListener('click', async () => {
    if (!b.itemIds.size) return toast('Pick at least one item');
    await db.put('outfits', { id: b.isNew ? db.newId() : b.id, name: b.name.trim(), createdAt: b.createdAt, itemIds: [...b.itemIds] });
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
  renderStrip();
  renderGrid();
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
      <strong>AI helpers (type detection, tap-to-select)</strong>
      <p class="muted">${hasModel ? `Downloaded (${models.TOTAL_MB} MB), works offline.` : 'Not downloaded. Types must be picked by hand.'}</p>
      ${hasModel ? '<button class="btn block" id="rmModel">Remove models</button>'
        : `<button class="btn block" id="dl">Download models (${models.TOTAL_MB} MB)</button><progress id="dlProg" value="0" max="1" hidden></progress>`}
      <div class="status" id="dlStatus"></div>
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
  $('#dl')?.addEventListener('click', () => downloadModels($('#dl'), $('#dlProg'), $('#dlStatus')));
  $('#rmModel')?.addEventListener('click', async () => { await models.deleteModels(); settingsView(); });
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
