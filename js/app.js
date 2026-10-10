import * as P from './pipeline.js';
import * as DB from './store.js';
import * as AI from './ai.js';
import { segment, lastRun as segRun } from './bgremove.js';
import { icon, hydrateIcons } from './icons.js';
import { EMOJI, SVG_STAMPS, svgUrl, emojiDataURL, FONTS, COLORS, GRADIENTS } from './stamps.js';

// ---------------- tiny on-device debug log (no keys, no image data) ----------------
const APP_VERSION = 'v6';
const DBG_KEY = 'photoapp.debug.v1';
const DBG = {
  read() { try { return JSON.parse(localStorage.getItem(DBG_KEY) || '[]'); } catch (e) { return []; } },
  push(kind, data) {
    try { const l = DBG.read(); l.push({ t: new Date().toISOString(), kind, ...data }); while (l.length > 12) l.shift();
      localStorage.setItem(DBG_KEY, JSON.stringify(l)); } catch (e) {}
  },
};
window.addEventListener('error', (e) => DBG.push('error', { msg: String(e.message).slice(0, 300) }));
window.addEventListener('unhandledrejection', (e) => DBG.push('error', { msg: String(e.reason?.message || e.reason).slice(0, 300) }));

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PROPS = ['kind', 'name', 'stampId'];

// AI-only mode: manual editing tools are hidden from the UI. The code stays; restore it with the hidden flag
// localStorage 'photoapp.manualTools' = '1' (or open the app once with ?manual=1; ?manual=0 turns it back off).
try { const q = new URLSearchParams(location.search).get('manual'); if (q === '1' || q === '0') localStorage.setItem('photoapp.manualTools', q); } catch (e) {}
const MANUAL = (() => { try { return localStorage.getItem('photoapp.manualTools') === '1'; } catch (e) { return false; } })();
document.documentElement.classList.toggle('ai-only', !MANUAL);
const S = {
  photos: [], cur: null, tool: null, mode: 'select', assets: new Map(),
  exp: JSON.parse(localStorage.getItem('photoapp.export') || '{"format":"jpeg","quality":0.92}'),
  scale: 1, cropRect: null, cropAspect: null, brushSize: 28, cache: {}, facing: 'environment', burst: 1,
};
window.__S = S;

// ---------------- UI helpers ----------------
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}
function busy(on, text) { $('#busy').classList.toggle('on', !!on); if (text) $('#busyText').textContent = text; }
function showScreen(id) { $$('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }
function openSheet(html, onMount) {
  const sh = $('#sheet'); sh.innerHTML = `<button class="icon-btn sheet-x" aria-label="Close" data-icon="x"></button>` + html; hydrateIcons(sh);
  sh.querySelector('.sheet-x').onclick = closeSheet;
  sh.classList.add('on'); $('#sheetBackdrop').classList.add('on');
  onMount?.(sh);
}
function closeSheet() { $('#sheet').classList.remove('on'); $('#sheetBackdrop').classList.remove('on'); }
$('#sheetBackdrop').onclick = closeSheet;

// ---------------- photos / assets ----------------
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.decoding = 'async'; i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read this image')); i.src = src; });
}
async function decodeBlob(blob) {
  const url = URL.createObjectURL(blob);
  try { return await loadImg(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function addPhoto(blob, persist = true) {
  const img = await decodeBlob(blob);
  const k = Math.min(1, P.FULL_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const p = { id: uid(), blob, w: Math.round(img.naturalWidth * k), h: Math.round(img.naturalHeight * k), created: Date.now(),
    edit: P.defaultEdit(), overlays: [], hist: [], hi: -1, edited: false };
  p.thumb = P.scaleToMax(img, 360).toDataURL('image/jpeg', 0.8);
  S.photos.push(p);
  if (persist) savePhoto(p, true);
  return p;
}
const saveTimers = {};
function savePhoto(p, now) {
  clearTimeout(saveTimers[p.id]);
  const doit = () => DB.put('photos', { id: p.id, blob: p.blob, w: p.w, h: p.h, created: p.created, edit: p.edit, overlays: p.overlays, thumb: p.thumb, edited: p.edited });
  if (now) doit(); else saveTimers[p.id] = setTimeout(doit, 600);
}
async function getPreview(p) {
  if (p.prev && P.canvasSig(p.prev) !== p.prevSig) { DBG.push('canvas', { msg: 'preview canvas was cleared by the browser; rebuilt' }); p.prev = null; S.cache = {}; }
  if (!p.prev) { const img = await decodeBlob(p.blob); p.prev = P.scaleToMax(img, P.PREVIEW_MAX); p.prevSig = P.canvasSig(p.prev); }
  return p.prev;
}
async function getFull(p) { const img = await decodeBlob(p.blob); return P.scaleToMax(img, P.FULL_MAX); }

async function addAsset(blobOrCanvas, kind) {
  const id = kind + '-' + uid();
  let blob = blobOrCanvas, img = null;
  if (blobOrCanvas instanceof HTMLCanvasElement) blob = await new Promise(r => blobOrCanvas.toBlob(r, 'image/png'));
  // keep a decoded <img> (not the canvas): iOS Safari can discard canvas contents under memory pressure
  if (blob) { try { img = await decodeBlob(blob); } catch (e) { img = null; } }
  if (!img) img = blobOrCanvas instanceof HTMLCanvasElement ? blobOrCanvas : null;
  if (!img) throw new Error('Could not store the image (out of memory?)');
  if (img !== blobOrCanvas && blobOrCanvas instanceof HTMLCanvasElement) P.freeCanvas(blobOrCanvas);
  S.assets.set(id, { img, kind });
  if (blob) DB.put('assets', { id, blob, kind });
  return id;
}
async function ensureAsset(id) {
  if (!id || S.assets.has(id)) return;
  const a = await DB.get('assets', id);
  if (a) S.assets.set(id, { img: await decodeBlob(a.blob), kind: a.kind });
}
async function ensureAssets(edit) { await ensureAsset(edit.bg.maskId); await ensureAsset(edit.bg.imageId); }
const maskOf = (edit) => edit.bg.maskId && S.assets.get(edit.bg.maskId)?.img;

// ---------------- gallery ----------------
function renderGallery() {
  const g = $('#grid'); g.innerHTML = '';
  $('#empty').classList.toggle('show', !S.photos.length);
  S.photos.forEach((p, i) => {
    const t = document.createElement('div'); t.className = 'tile';
    t.innerHTML = `<img src="${p.thumb}" alt="Photo ${i + 1}"><button class="del" aria-label="Delete photo">${icon('trash')}</button>${p.edited ? '<span class="badge">edited</span>' : ''}`;
    t.querySelector('img').onclick = () => openEditor(p);
    t.querySelector('.del').onclick = (e) => { e.stopPropagation(); deletePhoto(p); };
    g.appendChild(t);
  });
  $('#btnSaveAll').disabled = $('#btnShareAll').disabled = !S.photos.length;
}
function deletePhoto(p) {
  if (!confirm('Delete this photo from the session? (Originals in your phone gallery are not affected.)')) return;
  S.photos = S.photos.filter(x => x !== p);
  DB.del('photos', p.id);
  renderGallery();
}
async function importFiles(files) {
  files = [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(f.name));
  if (!files.length) return 0;
  busy(true, `Importing ${files.length} photo${files.length > 1 ? 's' : ''}…`);
  let ok = 0;
  for (const f of files) { try { await addPhoto(f); ok++; } catch (e) { console.warn(e); toast(`Couldn't open ${f.name} (format not supported by this browser)`); } }
  busy(false); renderGallery();
  if (ok) toast(`Added ${ok} photo${ok > 1 ? 's' : ''}`);
  return ok;
}
$('#fileImport').onchange = async (e) => { const n = await importFiles(e.target.files); e.target.value = ''; if (n === 1 && $('#gallery').classList.contains('active')) openEditor(S.photos[S.photos.length - 1]); };
$('#fileCapture').onchange = async (e) => { await importFiles(e.target.files); e.target.value = ''; };

// ---------------- camera ----------------
let stream = null, camShots = 0;
async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) { $('#fileCapture').click(); return; }
  camShots = 0; $('#camStrip').innerHTML = ''; $('#camCount').textContent = '';
  showScreen('camera');
  await startStream();
}
async function startStream() {
  stopStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: S.facing }, width: { ideal: 4096 }, height: { ideal: 3072 } } });
    const v = $('#video'); v.srcObject = stream; await v.play().catch(() => {});
    v.classList.toggle('mirror', S.facing === 'user');
  } catch (e) {
    console.warn(e); toast('Camera unavailable, opening your camera app instead');
    closeCamera(); $('#fileCapture').click();
  }
}
function stopStream() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }
function closeCamera() { stopStream(); showScreen('gallery'); renderGallery(); }
async function snap() {
  const v = $('#video'); if (!v.videoWidth) return;
  const c = P.makeCanvas(v.videoWidth, v.videoHeight), g = c.getContext('2d');
  if (S.facing === 'user') { g.translate(c.width, 0); g.scale(-1, 1); }
  g.drawImage(v, 0, 0);
  const f = $('#flash'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
  const p = await addPhoto(blob);
  camShots++; $('#camCount').textContent = `(${camShots})`;
  const im = new Image(); im.src = p.thumb; $('#camStrip').appendChild(im); im.scrollIntoView({ inline: 'end' });
}
$('#shutter').onclick = async () => { for (let i = 0; i < S.burst; i++) { await snap(); if (i < S.burst - 1) await sleep(220); } };
$('#camFlip').onclick = () => { S.facing = S.facing === 'user' ? 'environment' : 'user'; startStream(); };
$('#camClose').onclick = closeCamera;
$('#camDone').onclick = closeCamera;
$$('#burstChips button').forEach(b => b.onclick = () => { S.burst = +b.dataset.burst; $$('#burstChips button').forEach(x => x.classList.toggle('on', x === b)); });

// ---------------- global actions ----------------
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'camera') openCamera();
  else if (act === 'import' || act === 'importFromCam') { if (act === 'importFromCam') closeCamera(); $('#fileImport').click(); }
  else if (act === 'saveAll' || act === 'shareAll') openPreview(S.photos, 'gallery');
});
$('#btnAISettings').onclick = () => aiSettingsSheet();
$('#btnHelp').onclick = () => helpSheet();
function debugReport() {
  const st = AI.loadSettings();
  const scrub = (t) => String(t).replace(/(sk-|gsk_|xai-|AIza)[A-Za-z0-9_\-]{6,}/g, '[key removed]');
  const p = S.cur;
  const info = {
    app: 'Photo Studio ' + APP_VERSION, time: new Date().toISOString(), ua: navigator.userAgent,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, memoryGB: navigator.deviceMemory || null,
    provider: st.provider, model: st.model, imageGen: !!(st.imageGen && st.imageModel),
    photo: p ? { w: p.w, h: p.h, bg: { mode: p.edit.bg.mode, hasMask: !!p.edit.bg.maskId, method: p.edit.bg.method } } : null,
    lastMask: segRun, log: DBG.read(),
  };
  return scrub(JSON.stringify(info, null, 1));
}
async function reportProblem() {
  const text = debugReport();
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch (e) {}
  openSheet(`<h3>Report a problem</h3>
    <p class="note">${copied ? '<b>Copied to clipboard.</b> ' : ''}Paste this into a message to whoever helps you with the app. It lists the last AI steps and background-removal stats. It contains <b>no API keys and no photos</b>.</p>
    <textarea id="dbgText" readonly style="width:100%;height:40vh;font:12px monospace">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>
    <div class="actions"><button class="big-btn primary" id="dbgCopy">Copy</button>${navigator.share ? '<button class="big-btn" id="dbgShare">Share…</button>' : ''}</div>`, (sh) => {
    $('#dbgCopy', sh).addEventListener('click', async () => {
      const ta = $('#dbgText', sh); let ok = false;
      try { await navigator.clipboard.writeText(ta.value); ok = true; } catch (e) { ta.removeAttribute('readonly'); ta.select(); ta.setSelectionRange(0, ta.value.length); try { ok = document.execCommand('copy'); } catch (e2) {} ta.setAttribute('readonly', ''); }
      toast(ok ? 'Copied' : 'Select the text and copy it manually');
    });
    $('#dbgShare', sh)?.addEventListener('click', () => navigator.share({ title: 'Photo Studio problem report', text }).catch(() => {}));
  });
  if (copied) toast('Problem report copied (no keys)');
}
function helpSheet() {
  openSheet(`<h3>Phone gallery & Google Drive</h3>
    <p class="note">Photo Studio works with your phone's own picker and share menu, so no Google sign-in is needed.</p>
    <ul class="help-list">
      <li><b>Pull photos in from Drive:</b> tap <b>Add photos</b>, then <b>Browse</b> / <b>Files</b> (Android) or <b>Choose File → Browse</b> (iPhone) and pick <b>Google Drive</b>.</li>
      <li><b>Put photos into Drive:</b> tap <b>Save</b>, check the preview, then <b>Approve &amp; Share</b> and choose <b>Drive</b>. Dropbox, iCloud, OneDrive and messages work the same way.</li>
      <li><b>Save to your phone gallery:</b> tap <b>Approve &amp; Save to phone</b>. On iPhone, choose <b>Save Image</b> in the menu that opens.</li>
    </ul>
    <div class="actions"><button class="big-btn primary" data-act="import" id="helpAdd">Add photos now</button><button class="big-btn" id="helpReport">Report a problem</button></div>`, (sh) => { $('#helpAdd', sh).addEventListener('click', closeSheet); $('#helpReport', sh).addEventListener('click', reportProblem); });
}

// ---------------- fabric editor ----------------
let fc, bgImg;
function initFabric() {
  fabric.Object.prototype.set({ transparentCorners: false, cornerColor: '#fff', cornerStrokeColor: '#4f8cff', borderColor: '#4f8cff', cornerStyle: 'circle', cornerSize: 20, touchCornerSize: 44, padding: 8, borderScaleFactor: 2 });
  if (fabric.Object.prototype.controls.mtr) fabric.Object.prototype.controls.mtr.offsetY = -36;
  fc = new fabric.Canvas('fc', { preserveObjectStacking: true, selection: false, allowTouchScrolling: false, uniformScaling: true, enableRetinaScaling: true, stopContextMenu: true });
  fc.on('object:modified', () => commit());
  if (!MANUAL) fc.skipTargetFind = true;
  fc.on('selection:created', onSelect); fc.on('selection:updated', onSelect); fc.on('selection:cleared', onSelect);
  setupPinch();
}
function onSelect() {
  if (!MANUAL && fc.getActiveObject()) { fc.discardActiveObject(); fc.requestRenderAll(); }
  const o = fc.getActiveObject();
  $('#objbar').classList.toggle('on', !!o && S.mode === 'select');
  $('#objEdit').style.display = o && o.kind === 'text' ? '' : 'none';
  if (S.tool === 'text' || S.tool === 'layers') renderPanel();
  requestAnimationFrame(layout);
}
function setupPinch() {
  const el = fc.wrapperEl;
  let g = null;
  const info = (t) => { const [a, b] = t; const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY; return { d: Math.hypot(dx, dy), a: Math.atan2(dy, dx) * 180 / Math.PI }; };
  el.addEventListener('touchstart', (e) => {
    if (!MANUAL || e.touches.length !== 2 || S.mode !== 'select') return;
    let o = fc.getActiveObject();
    if (!o) {
      const r = fc.upperCanvasEl.getBoundingClientRect();
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
      const pt = new fabric.Point(mx / S.scale, my / S.scale);
      o = [...fc.getObjects()].reverse().find(ob => ob.containsPoint(pt, null, true));
      if (o) fc.setActiveObject(o);
    }
    if (!o) return;
    const i = info(e.touches);
    g = { o, d0: i.d, a0: i.a, sx: o.scaleX, sy: o.scaleY, ang: o.angle };
    e.preventDefault(); e.stopPropagation();
  }, { capture: true, passive: false });
  el.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length !== 2) return;
    const i = info(e.touches), k = i.d / g.d0;
    g.o.set({ scaleX: g.sx * k, scaleY: g.sy * k, angle: g.ang + (i.a - g.a0) });
    g.o.setCoords(); fc.requestRenderAll();
    e.preventDefault(); e.stopPropagation();
  }, { capture: true, passive: false });
  el.addEventListener('touchend', (e) => { if (g && e.touches.length < 2) { g = null; commit(); } }, { capture: true });
}

function fullDims() {
  const p = S.cur;
  if (S.mode === 'crop') { const g = P.geomDims(p.w, p.h, p.edit.orient); return { w: g.w, h: g.h }; }
  return P.outDims(p.w, p.h, p.edit);
}
function layout() {
  if (!S.cur || !fc || !$('#editor').classList.contains('active')) return;
  const d = fullDims();
  const st = $('#stage').getBoundingClientRect();
  const pad = S.mode === 'crop' ? 28 : 12;
  const s = Math.max(0.01, Math.min((st.width - pad * 2) / d.w, (st.height - pad * 2) / d.h));
  S.scale = s;
  const W = Math.round(d.w * s), H = Math.round(d.h * s);
  fc.setDimensions({ width: W, height: H });
  fc.setZoom(s);
  const b = $('#brush'); b.width = W * devicePixelRatio; b.height = H * devicePixelRatio; b.style.width = W + 'px'; b.style.height = H + 'px';
  if (S.mode === 'crop') positionCropBox();
  fc.requestRenderAll();
}
window.addEventListener('resize', () => layout());

let renderQueued = false, rendering = false;
function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderBase(); }); }
function renderBaseRetry() { setTimeout(() => { rendering = false; renderBase(); }, 0); }
async function renderBase(original = false) {
  const p = S.cur; if (!p) return;
  if (rendering) { setTimeout(scheduleRender, 30); return; }
  rendering = true;
  try {
    const src = await getPreview(p);
    await ensureAssets(p.edit);
    const e = p.edit, C = S.cache;
    let out;
    if (original) out = P.applyGeometry(src, e, S.mode === 'crop');
    else {
      const hk = p.id + JSON.stringify(e.heal);
      if (C.hk !== hk) { C.hk = hk; C.healed = P.applyHeal(src, e.heal); C.ak = null; }
      const ak = hk + JSON.stringify([e.adj, e.filter, e.filterAmt, e.auto]);
      if (C.ak === ak && C.adjusted && P.canvasSig(C.adjusted) !== C.adjSig) { C.ak = null; C.hk = null; DBG.push('canvas', { msg: 'cached canvas cleared by the browser; rebuilt' }); return renderBaseRetry(); }
      if (C.ak !== ak) { C.ak = ak; C.adjusted = P.adjustCanvas(C.healed, e); C.adjSig = P.canvasSig(C.adjusted); }
      const composed = P.composeBackground(C.adjusted, e.bg, maskOf(e), S.assets);
      out = P.applyGeometry(composed, e, S.mode === 'crop');
      if (composed !== out && composed !== C.adjusted) P.freeCanvas(composed);
    }
    const prevEl = bgImg && bgImg.getElement();
    const d = fullDims();
    if (!bgImg) bgImg = new fabric.Image(out, { left: 0, top: 0, originX: 'left', originY: 'top', selectable: false, evented: false, objectCaching: false });
    else bgImg.setElement(out);
    if (prevEl && prevEl !== out && prevEl !== S.cache.adjusted && prevEl !== S.cache.healed && prevEl !== p.prev && !S.photos.some(q => q.prev === prevEl)) P.freeCanvas(prevEl);
    bgImg.set({ scaleX: d.w / out.width, scaleY: d.h / out.height, width: out.width, height: out.height });
    fc.backgroundImage = bgImg;
    fc.requestRenderAll();
  } catch (err) { console.error(err); toast('Render error: ' + err.message); }
  finally { rendering = false; }
}

function enliven(objs) {
  return new Promise(res => fabric.util.enlivenObjects(clone(objs || []), (os) => res(os)));
}
async function setOverlays(objs) {
  fc.discardActiveObject();
  fc.getObjects().slice().forEach(o => fc.remove(o));
  const os = await enliven(objs);
  os.forEach(o => fc.add(o));
  fc.requestRenderAll();
}
const currentOverlays = () => fc.getObjects().map(o => o.toObject(PROPS));
function snapshot() { return { edit: clone(S.cur.edit), overlays: currentOverlays() }; }
function commit() {
  const p = S.cur; if (!p) return;
  if (!S.aiRunning && S.aiProposal) hideAIBar();
  p.overlays = currentOverlays();
  p.hist = p.hist.slice(0, p.hi + 1);
  p.hist.push(snapshot());
  if (p.hist.length > 60) p.hist.shift();
  p.hi = p.hist.length - 1;
  p.edited = true;
  savePhoto(p);
  updateUndo();
}
function updateUndo() { const p = S.cur; $('#btnUndo').disabled = !p || p.hi <= 0; $('#btnRedo').disabled = !p || p.hi >= p.hist.length - 1; }
async function restore(i) {
  const p = S.cur; const s = p && p.hist[i]; if (!s) return;
  if (S.mode !== 'select') setMode('select', true);
  p.hi = i; p.edit = clone(s.edit); p.overlays = clone(s.overlays);
  await setOverlays(p.overlays);
  layout(); await renderBase(); updateUndo(); savePhoto(p);
  if (S.tool) renderPanel();
}
$('#btnUndo').onclick = () => restore(S.cur.hi - 1);
$('#btnRedo').onclick = () => restore(S.cur.hi + 1);

function stashCurrent() {
  const p = S.cur; if (!p || !fc) return;
  if (S.mode !== 'select') setMode('select');
  fc.discardActiveObject(); fc.renderAll();
  try { const m = 360 / Math.max(fc.width, fc.height); p.thumb = fc.toCanvasElement(m).toDataURL('image/jpeg', 0.8); } catch (e) { console.warn(e); }
  p.overlays = currentOverlays(); savePhoto(p, true);
  p.prev = null;
}
async function openEditor(p, opts = {}) {
  if (S.cur && S.cur !== p) stashCurrent();
  if (S.cur !== p) hideAIBar();
  S.cur = p; S.cache = {}; S.mode = 'select';
  showScreen('editor');
  if (!fc) initFabric();
  busy(true, 'Opening…');
  try {
    await getPreview(p);
    await setOverlays(p.overlays);
    if (!p.hist.length) { p.hist = [snapshot()]; p.hi = 0; }
    $('#edPos').textContent = S.photos.length > 1 ? `${S.photos.indexOf(p) + 1} / ${S.photos.length}` : '';
    selectTool(MANUAL ? (S.tool || 'adjust') : 'ai');
    layout(); await renderBase(); updateUndo();
  } finally { if (!opts.keepBusy) busy(false); }
}
async function closeEditor() {
  if (!S.cur) return;
  stashCurrent(); hideAIBar();
  S.cur = null; showScreen('gallery'); renderGallery();
}
$('#edBack').onclick = closeEditor;

const cmp = $('#btnCompare');
const cmpOn = (e) => { e.preventDefault(); if (!S.cur) return; fc.getObjects().forEach(o => o.visible = false); renderBase(true); };
const cmpOff = () => { if (S.cur && fc.getObjects().some(o => !o.visible)) { fc.getObjects().forEach(o => o.visible = true); renderBase(); } };
cmp.addEventListener('pointerdown', cmpOn); cmp.addEventListener('pointerup', cmpOff); cmp.addEventListener('pointerleave', cmpOff);

$('#objbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-obj]'); if (!b) return;
  const o = fc.getActiveObject(); if (!o) return;
  const a = b.dataset.obj;
  if (a === 'forward') { fc.bringForward(o); commit(); }
  else if (a === 'backward') { fc.sendBackwards(o); commit(); }
  else if (a === 'delete') { fc.remove(o); fc.discardActiveObject(); commit(); }
  else if (a === 'duplicate') duplicate(o);
  else if (a === 'edit') selectTool('text');
  fc.requestRenderAll(); if (S.tool === 'layers') renderPanel();
});
function duplicate(o) {
  o.clone((c) => { c.set({ left: o.left + 40, top: o.top + 40 }); fc.add(c); fc.setActiveObject(c); commit(); fc.requestRenderAll(); }, PROPS);
}
document.addEventListener('keydown', (e) => {
  if (!S.cur || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && fc.getActiveObject()) { fc.remove(fc.getActiveObject()); commit(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? restore(S.cur.hi + 1) : restore(S.cur.hi - 1); }
});

// ---------------- modes: crop / heal ----------------
function shiftObjs(dx, dy) { fc.getObjects().forEach(o => { o.set({ left: o.left + dx, top: o.top + dy }); o.setCoords(); }); }
function setMode(m, cancel = false) {
  const p = S.cur;
  if (S.mode === m) return;
  if (S.mode === 'crop') {
    const g = P.geomDims(p.w, p.h, p.edit.orient);
    const cr = cancel ? p.edit.crop : S.cropRect;
    shiftObjs(-cr.x * g.w, -cr.y * g.h);
    const changed = JSON.stringify(cr) !== JSON.stringify(p.edit.crop) || S.cropDirty;
    p.edit.crop = { ...cr };
    $('#cropBox').classList.remove('on');
    S.mode = m;
    if (changed && !cancel) commit();
  }
  if (S.mode === 'heal') $('#brush').classList.remove('on');
  S.mode = m;
  if (m === 'crop') {
    fc.discardActiveObject();
    const g = P.geomDims(p.w, p.h, p.edit.orient);
    S.cropRect = { ...p.edit.crop }; S.cropDirty = false; S.cropAspect = null;
    shiftObjs(p.edit.crop.x * g.w, p.edit.crop.y * g.h);
    fc.getObjects().forEach(o => { o.selectable = o.evented = false; });
    $('#cropBox').classList.add('on');
  } else fc.getObjects().forEach(o => { o.selectable = o.evented = true; });
  if (m === 'heal') { fc.discardActiveObject(); $('#brush').classList.add('on'); }
  fc.skipTargetFind = !MANUAL || m !== 'select';
  onSelect(); layout(); scheduleRender();
}
function positionCropBox() {
  const r = S.cropRect, W = fc.width, H = fc.height, b = $('#cropBox');
  Object.assign(b.style, { left: r.x * W + 'px', top: r.y * H + 'px', width: r.w * W + 'px', height: r.h * H + 'px' });
}
(function cropDrag() {
  const box = $('#cropBox'); let st = null;
  box.addEventListener('pointerdown', (e) => {
    e.preventDefault(); box.setPointerCapture(e.pointerId);
    st = { h: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, r: { ...S.cropRect } };
  });
  box.addEventListener('pointermove', (e) => {
    if (!st) return;
    const W = fc.width, H = fc.height, dx = (e.clientX - st.x) / W, dy = (e.clientY - st.y) / H, r0 = st.r, MIN = 0.05;
    let { x, y, w, h } = r0;
    if (st.h === 'move') { x = Math.min(1 - w, Math.max(0, x + dx)); y = Math.min(1 - h, Math.max(0, y + dy)); }
    else {
      if (st.h.includes('w')) { x = Math.min(r0.x + r0.w - MIN, Math.max(0, r0.x + dx)); w = r0.x + r0.w - x; }
      if (st.h.includes('e')) w = Math.min(1 - r0.x, Math.max(MIN, r0.w + dx));
      if (st.h.includes('n')) { y = Math.min(r0.y + r0.h - MIN, Math.max(0, r0.y + dy)); h = r0.y + r0.h - y; }
      if (st.h.includes('s')) h = Math.min(1 - r0.y, Math.max(MIN, r0.h + dy));
      if (S.cropAspect) {
        let want = (w * W) / S.cropAspect / H;
        const top = st.h.includes('n') ? r0.y + r0.h - want : y;
        if (top < 0 || top + want > 1) { want = st.h.includes('n') ? r0.y + r0.h : 1 - y; w = want * H * S.cropAspect / W; if (st.h.includes('w')) x = r0.x + r0.w - w; }
        if (st.h.includes('n')) y = r0.y + r0.h - want;
        h = want;
      }
    }
    S.cropRect = { x, y, w, h }; S.cropDirty = true; positionCropBox();
  });
  const end = () => { st = null; };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
})();
function setCropAspect(a) {
  S.cropAspect = a;
  const W = fc.width, H = fc.height;
  if (!a) return;
  let w = 1, h = (W / a) / H;
  if (h > 1) { h = 1; w = (H * a) / W; }
  S.cropRect = { x: (1 - w) / 2, y: (1 - h) / 2, w, h }; S.cropDirty = true; positionCropBox();
}
const ORIENT = { cw: P.ROT_CW, ccw: P.ROT_CCW, h: P.FLIP_H, v: P.FLIP_V };
function transformCrop(k, r) {
  if (k === 'cw') return { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w };
  if (k === 'ccw') return { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w };
  if (k === 'h') return { ...r, x: 1 - (r.x + r.w) };
  return { ...r, y: 1 - (r.y + r.h) };
}
function geomOp(k, silent) {
  const p = S.cur, inCrop = S.mode === 'crop';
  const g = P.geomDims(p.w, p.h, p.edit.orient);
  let crop = inCrop ? S.cropRect : p.edit.crop;
  if (!inCrop) shiftObjs(crop.x * g.w, crop.y * g.h);
  fc.getObjects().forEach(o => {
    const c = o.getCenterPoint(); let x = c.x, y = c.y, a = o.angle;
    if (k === 'cw') { x = g.h - c.y; y = c.x; a += 90; }
    else if (k === 'ccw') { x = c.y; y = g.w - c.x; a -= 90; }
    else if (k === 'h') x = g.w - c.x; else y = g.h - c.y;
    o.set({ angle: a }); o.setPositionByOrigin(new fabric.Point(x, y), 'center', 'center'); o.setCoords();
  });
  crop = transformCrop(k, crop);
  p.edit.orient = P.mulOrient(ORIENT[k], p.edit.orient);
  if (S.cropAspect && (k === 'cw' || k === 'ccw')) S.cropAspect = 1 / S.cropAspect;
  const g2 = P.geomDims(p.w, p.h, p.edit.orient);
  if (inCrop) { S.cropRect = crop; S.cropDirty = true; }
  else { p.edit.crop = crop; shiftObjs(-crop.x * g2.w, -crop.y * g2.h); if (!silent) commit(); }
  layout(); scheduleRender();
}
function setCrop(nc) {
  const p = S.cur, g = P.geomDims(p.w, p.h, p.edit.orient), o = p.edit.crop;
  shiftObjs((o.x - nc.x) * g.w, (o.y - nc.y) * g.h);
  p.edit.crop = nc;
}
function aspectCrop(a) {
  const p = S.cur, g = P.geomDims(p.w, p.h, p.edit.orient);
  let w = 1, h = (g.w / a) / g.h; if (h > 1) { h = 1; w = (g.h * a) / g.w; }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

(function healBrush() {
  const b = $('#brush'); let pts = null;
  const ctx = () => b.getContext('2d');
  const pos = (e) => { const r = b.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault(); b.setPointerCapture(e.pointerId); pts = [pos(e)];
    const g = ctx(); g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); g.clearRect(0, 0, b.width, b.height);
    g.fillStyle = g.strokeStyle = 'rgba(255,60,90,.55)'; g.lineWidth = S.brushSize; g.lineCap = g.lineJoin = 'round';
    g.beginPath(); g.arc(pts[0][0], pts[0][1], S.brushSize / 2, 0, 7); g.fill();
  });
  b.addEventListener('pointermove', (e) => {
    if (!pts) return; const pt = pos(e), last = pts[pts.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 2) return;
    pts.push(pt); const g = ctx(); g.beginPath(); g.moveTo(last[0], last[1]); g.lineTo(pt[0], pt[1]); g.stroke();
  });
  const end = () => {
    if (!pts) return; const p = S.cur, e = p.edit, s = S.scale;
    const g = P.geomDims(p.w, p.h, e.orient), o = e.orient, L = Math.max(p.w, p.h);
    const map = ([dx, dy]) => {
      const gx = dx / s + e.crop.x * g.w - g.w / 2, gy = dy / s + e.crop.y * g.h - g.h / 2;
      const sx = o.a * gx + o.b * gy, sy = o.c * gx + o.d * gy;
      return [+((sx + p.w / 2) / p.w).toFixed(5), +((sy + p.h / 2) / p.h).toFixed(5)];
    };
    e.heal.push({ r: +(S.brushSize / 2 / s / L).toFixed(5), pts: pts.map(map) });
    pts = null;
    busy(true, 'Cleaning…');
    setTimeout(async () => { await renderBase(); ctx().clearRect(0, 0, b.width, b.height); busy(false); commit(); renderPanel(); }, 30);
  };
  b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
})();

// ---------------- tools & panels ----------------
$('#tools').addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) selectTool(b.dataset.tool, true); });
function selectTool(t, user) {
  if (!MANUAL) t = 'ai', user = false; // AI-only: the AI panel is the only panel and stays open
  if (user && S.tool === t) S.tool = null; else S.tool = t;
  $$('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === S.tool));
  if (S.tool !== 'crop' && S.mode === 'crop') setMode('select');
  if (S.tool !== 'clean' && S.mode === 'heal') setMode('select');
  if (S.tool === 'crop' && S.mode !== 'crop') setMode('crop');
  renderPanel();
  requestAnimationFrame(layout);
}
function renderPanel() {
  const pn = $('#panel'); pn.classList.toggle('on', !!S.tool);
  if (!S.tool || !S.cur) { pn.innerHTML = ''; return; }
  const st = pn.scrollTop;
  pn.innerHTML = ''; PANELS[S.tool](pn); hydrateIcons(pn);
  pn.scrollTop = st;
}
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
function slider(label, val, min, max, onInput, onChange, step = 1) {
  const el = h(`<div class="slider"><label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" aria-label="${label}"><output>${val}</output></div>`);
  const r = el.querySelector('input'), o = el.querySelector('output');
  r.oninput = () => { o.textContent = r.value; onInput(+r.value); };
  r.onchange = () => onChange?.(+r.value);
  return el;
}

const PANELS = {
  adjust(pn) {
    const e = S.cur.edit;
    const L = { brightness: 'Brightness', contrast: 'Contrast', saturation: 'Saturation', warmth: 'Warmth', sharpness: 'Sharpen / Blur' };
    Object.keys(L).forEach(k => pn.appendChild(slider(L[k], e.adj[k], -100, 100, v => { e.adj[k] = v; scheduleRender(); }, () => commit())));
    pn.appendChild(h(`<div class="row"><button class="chip ${e.auto ? 'on' : ''}" id="adjAuto">${icon('wand')} Auto-enhance</button><button class="chip" id="adjReset">Reset</button></div>`));
    $('#adjAuto', pn).onclick = () => magicAuto();
    $('#adjReset', pn).onclick = () => { e.adj = { ...P.DEFAULT_ADJ }; e.auto = null; renderBase(); commit(); renderPanel(); };
  },
  filters(pn) {
    const e = S.cur.edit;
    const wrap = h('<div class="hscroll"></div>'); pn.appendChild(wrap);
    const small = P.scaleToMax(S.cur.prev, 160);
    Object.entries(P.FILTERS).forEach(([k, f]) => {
      const card = h(`<button class="filter-card ${e.filter === k ? 'on' : ''}"><canvas></canvas>${f.label}</button>`);
      const cv = card.querySelector('canvas');
      const out = P.adjustCanvas(small, { ...P.defaultEdit(), filter: k, filterAmt: 100 });
      cv.width = out.width; cv.height = out.height; cv.getContext('2d').drawImage(out, 0, 0);
      card.onclick = () => { e.filter = k; e.filterAmt = e.filterAmt || 100; renderBase(); commit(); renderPanel(); };
      wrap.appendChild(card);
    });
    if (e.filter !== 'none') pn.appendChild(slider('Strength', e.filterAmt, 0, 100, v => { e.filterAmt = v; scheduleRender(); }, () => commit()));
  },
  crop(pn) {
    pn.appendChild(h(`<div><div class="sec">Rotate & flip</div><div class="row">
      <button class="chip" data-g="ccw">${icon('rotateL')} Left</button><button class="chip" data-g="cw">${icon('rotate')} Right</button>
      <button class="chip" data-g="h">${icon('flipH')} Flip ↔</button><button class="chip" data-g="v">${icon('flipV')} Flip ↕</button></div>
      <div class="sec">Aspect — drag the box or its corners</div><div class="hscroll" id="aspects"></div>
      <div class="row" style="margin-top:10px"><button class="chip primary" id="cropDone">${icon('check')} Apply</button><button class="chip" id="cropReset">Reset</button><button class="chip" id="cropCancel">Cancel</button></div></div>`));
    $$('[data-g]', pn).forEach(b => b.onclick = () => geomOp(b.dataset.g));
    [['Free', null], ['Original', 'orig'], ['1:1', 1], ['4:5', 4 / 5], ['3:4', 3 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['4:3', 4 / 3]].forEach(([n, v]) => {
      const b = h(`<button class="chip">${n}</button>`);
      b.onclick = () => { $$('#aspects .chip').forEach(x => x.classList.remove('on')); b.classList.add('on'); setCropAspect(v === 'orig' ? fc.width / fc.height : v); };
      $('#aspects', pn).appendChild(b);
    });
    $('#cropDone', pn).onclick = () => selectTool('adjust');
    $('#cropReset', pn).onclick = () => { S.cropAspect = null; S.cropRect = { x: 0, y: 0, w: 1, h: 1 }; S.cropDirty = true; positionCropBox(); };
    $('#cropCancel', pn).onclick = () => { setMode('select', true); selectTool('adjust'); };
  },
  clean(pn) {
    const on = S.mode === 'heal';
    pn.appendChild(h(`<div><div class="row"><button class="chip ${S.cur.edit.auto ? 'on' : ''}" id="cAuto">${icon('wand')} Auto-enhance</button>
      <button class="chip ${on ? 'on' : ''}" id="cHeal">${icon('brush')} ${on ? 'Brush on: paint over spots' : 'Spot heal / erase brush'}</button></div>
      <p class="note">Turn on the brush, then paint over a blemish, dust spot or small object. It's filled in from the surrounding area. Undo removes the last stroke.</p></div>`));
    pn.appendChild(slider('Brush size', S.brushSize, 6, 120, v => { S.brushSize = v; }));
    $('#cAuto', pn).onclick = () => magicAuto();
    $('#cHeal', pn).onclick = () => { setMode(S.mode === 'heal' ? 'select' : 'heal'); renderPanel(); };
    if (S.cur.edit.heal.length) { const b = h(`<button class="chip">Remove all ${S.cur.edit.heal.length} fixes</button>`); b.onclick = () => { S.cur.edit.heal = []; renderBase(); commit(); renderPanel(); }; pn.appendChild(b); }
  },
  bg(pn) {
    const bg = S.cur.edit.bg, has = !!bg.maskId;
    pn.appendChild(h(`<div><div class="row">
      <button class="chip ${has ? '' : 'primary'}" id="bgQuick">${icon('sparkle')} ${has ? 'Redo (people)' : 'Remove background'}</button>
      <button class="chip" id="bgPrecise">Precise (any subject)</button></div>
      <p class="note">${has ? 'Pick a new background:' : 'Runs on your phone. “Remove background” is tuned for people; “Precise” works on any subject but downloads a ~40 MB model the first time.'}</p></div>`));
    $('#bgQuick', pn).onclick = () => removeBg('quick');
    $('#bgPrecise', pn).onclick = () => removeBg('precise');
    if (!has) return;
    const row = h('<div class="hscroll"></div>');
    [['none', 'Original'], ['transparent', 'Transparent'], ['color', 'Color'], ['gradient', 'Gradient'], ['blur', 'Blur'], ['image', 'Photo']].forEach(([m, n]) => {
      const b = h(`<button class="chip ${bg.mode === m ? 'on' : ''}">${n}</button>`);
      b.onclick = () => { if (m === 'image' && !bg.imageId) { $('#fileBgImage').click(); return; } bg.mode = m; renderBase(); commit(); renderPanel(); };
      row.appendChild(b);
    });
    if (AI.hasKey()) { const b = h(`<button class="chip">${icon('sparkle')} AI scene</button>`); b.onclick = () => { selectTool('ai'); $('#aiInput').value = 'Put a sunny tropical beach behind me'; $('#aiInput').focus(); }; row.appendChild(b); }
    pn.appendChild(row);
    if (bg.mode === 'color') {
      const r = h('<div class="row"></div>');
      COLORS.forEach(c => { const s = h(`<button class="swatch ${bg.color === c ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`); s.onclick = () => { bg.color = c; renderBase(); commit(); renderPanel(); }; r.appendChild(s); });
      const ci = h(`<input type="color" value="${bg.color}">`); ci.oninput = () => { bg.color = ci.value; scheduleRender(); }; ci.onchange = () => commit(); r.appendChild(ci);
      pn.appendChild(r);
    } else if (bg.mode === 'gradient') {
      const r = h('<div class="hscroll"></div>');
      GRADIENTS.forEach(g => { const s = h(`<button class="chip" style="background:linear-gradient(${g.angle}deg,${g.c1},${g.c2});color:#000">${g.name}</button>`); s.onclick = () => { Object.assign(bg, { c1: g.c1, c2: g.c2, angle: g.angle }); renderBase(); commit(); renderPanel(); }; r.appendChild(s); });
      pn.appendChild(r);
      pn.appendChild(h(`<div class="row"><input type="color" id="g1" value="${bg.c1}"><input type="color" id="g2" value="${bg.c2}"></div>`));
      $('#g1', pn).oninput = (ev) => { bg.c1 = ev.target.value; scheduleRender(); }; $('#g2', pn).oninput = (ev) => { bg.c2 = ev.target.value; scheduleRender(); };
      $('#g1', pn).onchange = $('#g2', pn).onchange = () => commit();
      pn.appendChild(slider('Angle', bg.angle, 0, 360, v => { bg.angle = v; scheduleRender(); }, () => commit()));
    } else if (bg.mode === 'blur') {
      pn.appendChild(slider('Blur', bg.blur, 4, 80, v => { bg.blur = v; scheduleRender(); }, () => commit()));
    } else if (bg.mode === 'image') {
      const b = h(`<button class="chip">${icon('image')} Choose another photo</button>`); b.onclick = () => $('#fileBgImage').click(); pn.appendChild(b);
    }
  },
  stamps(pn) {
    pn.appendChild(h(`<div class="row"><button class="chip primary" id="stMine">${icon('plus')} Use your own image</button></div>`));
    $('#stMine', pn).onclick = () => $('#fileStamp').click();
    const mine = [...S.assets.entries()].filter(([, a]) => a.kind === 'stamp');
    if (mine.length) {
      pn.appendChild(h('<div class="sec">Your stamps</div>'));
      const g = h('<div class="stamp-grid"></div>');
      mine.forEach(([, a]) => { const b = h('<button aria-label="My stamp"></button>'); const im = new Image(); im.src = a.url; b.appendChild(im); b.onclick = () => addImageObj(a.url, { kind: 'stamp', name: 'My stamp' }); g.appendChild(b); });
      pn.appendChild(g);
    }
    pn.appendChild(h('<div class="sec">Stickers</div>'));
    const g2 = h('<div class="stamp-grid"></div>');
    SVG_STAMPS.forEach(s => { const b = h(`<button aria-label="${s.id}"><img src="${svgUrl(s.svg)}" alt=""></button>`); b.onclick = () => addImageObj(svgUrl(s.svg), { kind: 'stamp', name: s.id }); g2.appendChild(b); });
    pn.appendChild(g2);
    pn.appendChild(h('<div class="sec">Emoji</div>'));
    const g = h('<div class="stamp-grid"></div>');
    EMOJI.forEach(ch => { const b = h(`<button>${ch}</button>`); b.onclick = () => addEmoji(ch); g.appendChild(b); });
    pn.appendChild(g);
  },
  text(pn) {
    const o = fc.getActiveObject(); const t = o && o.kind === 'text' ? o : null;
    S.textStyle ||= {};
    pn.appendChild(h(`<div><div class="row nowrap"><textarea id="txIn" rows="1" placeholder="Type your words…" style="flex:1"></textarea>
      <button class="chip primary" id="txAdd">${t ? 'Done' : icon('plus') + ' Add'}</button></div></div>`));
    const ta = $('#txIn', pn); ta.value = t ? t.text : '';
    $('#txAdd', pn).onclick = () => { const val = ta.value.trim(); if (!val) { ta.focus(); return; } if (t) { t.set({ text: val }); fc.requestRenderAll(); commit(); fc.discardActiveObject(); fc.requestRenderAll(); } else addText(val); };
    if (t) { ta.oninput = () => { if (ta.value.trim()) { t.set({ text: ta.value }); t.setCoords(); fc.requestRenderAll(); } }; ta.onchange = () => commit(); }
    const set = (props) => { if (!t) { Object.assign(S.textStyle, props); renderPanel(); return; } t.set(props); t.setCoords(); fc.requestRenderAll(); commit(); renderPanel(); };
    const st = t || S.textStyle;
    pn.appendChild(h('<div class="sec">Font</div>'));
    const fr = h('<div class="hscroll"></div>');
    const curFont = st.fontFamily || FONTS[0].css;
    FONTS.forEach(f => { const b = h(`<button class="chip font-chip ${curFont === f.css ? 'on' : ''}" style="font-family:${f.css.replace(/"/g, "'")};font-weight:${f.weight || 400}">${f.name}</button>`); b.onclick = async () => { await loadFont(f); set({ fontFamily: f.css, fontWeight: f.weight || 400 }); }; fr.appendChild(b); });
    pn.appendChild(fr);
    pn.appendChild(h('<div class="sec">Color</div>'));
    const cr = h('<div class="row"></div>');
    const curFill = st.fill || '#ffffff';
    COLORS.forEach(c => { const s = h(`<button class="swatch ${curFill === c ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`); s.onclick = () => set({ fill: c }); cr.appendChild(s); });
    const ci = h(`<input type="color" value="${/^#[0-9a-f]{6}$/i.test(curFill) ? curFill : '#ffffff'}">`); ci.onchange = () => set({ fill: ci.value }); cr.appendChild(ci);
    pn.appendChild(cr);
    const outlineOn = t ? !!t.stroke : st.stroke !== null, shadowOn = !!st.shadow, boxOn = !!st.backgroundColor;
    pn.appendChild(h(`<div class="row"><button class="chip ${outlineOn ? 'on' : ''}" id="txO">Outline</button><button class="chip ${shadowOn ? 'on' : ''}" id="txS">Shadow</button><button class="chip ${boxOn ? 'on' : ''}" id="txB">Label box</button>${t ? '<button class="chip" id="txAl">Align</button>' : ''}</div>`));
    const fs = () => (t ? t.fontSize : 80);
    $('#txO', pn).onclick = () => set(outlineOn ? { stroke: null, strokeWidth: 0 } : { stroke: '#000000', strokeWidth: Math.max(2, fs() * 0.07), paintFirst: 'stroke', strokeLineJoin: 'round' });
    $('#txS', pn).onclick = () => set({ shadow: shadowOn ? null : new fabric.Shadow({ color: 'rgba(0,0,0,0.6)', blur: fs() * 0.15, offsetX: fs() * 0.04, offsetY: fs() * 0.04 }) });
    $('#txB', pn).onclick = () => set({ backgroundColor: boxOn ? '' : 'rgba(0,0,0,0.55)' });
    if (t) {
      $('#txAl', pn).onclick = () => set({ textAlign: { left: 'center', center: 'right', right: 'left' }[t.textAlign] || 'center' });
      pn.appendChild(slider('Size', Math.round(t.scaleX * 100), 10, 600, v => { t.set({ scaleX: v / 100, scaleY: v / 100 }); t.setCoords(); fc.requestRenderAll(); }, () => commit()));
      if (t.stroke) { const r = h('<div class="row"><span class="note">Outline color</span></div>'); const i = h(`<input type="color" value="${/^#[0-9a-f]{6}$/i.test(t.stroke) ? t.stroke : '#000000'}">`); i.onchange = () => set({ stroke: i.value }); r.appendChild(i); pn.appendChild(r); }
      pn.appendChild(slider('Opacity', Math.round(t.opacity * 100), 10, 100, v => { t.set({ opacity: v / 100 }); fc.requestRenderAll(); }, () => commit()));
    } else pn.appendChild(h('<p class="note">Tip: drag words to move them; pinch or use the corner handles to resize; the top handle rotates.</p>'));
  },
  layers(pn) {
    const objs = fc.getObjects().slice().reverse();
    if (!objs.length) { pn.appendChild(h('<p class="note">No stamps or text yet. Add some from the Stamps or Text tools.</p>')); return; }
    const act = fc.getActiveObject();
    pn.appendChild(h('<div class="sec">Top to bottom</div>'));
    objs.forEach(o => {
      const nm = o.kind === 'text' ? `“${o.text.slice(0, 30)}”` : (o.name || 'Stamp');
      const it = h(`<div class="layer-item ${o === act ? 'on' : ''}"><div class="nm"></div>
        <button data-l="up" aria-label="Bring forward">${icon('up')}</button><button data-l="down" aria-label="Send back">${icon('down')}</button>
        <button data-l="dup" aria-label="Duplicate">${icon('copy')}</button><button data-l="del" aria-label="Delete">${icon('trash')}</button></div>`);
      it.querySelector('.nm').textContent = (o.kind === 'text' ? 'Text ' : 'Stamp ') + nm;
      it.querySelector('.nm').onclick = () => { fc.setActiveObject(o); fc.requestRenderAll(); renderPanel(); };
      it.querySelector('[data-l=up]').onclick = () => { fc.bringForward(o); commit(); renderPanel(); };
      it.querySelector('[data-l=down]').onclick = () => { fc.sendBackwards(o); commit(); renderPanel(); };
      it.querySelector('[data-l=dup]').onclick = () => { duplicate(o); setTimeout(renderPanel, 50); };
      it.querySelector('[data-l=del]').onclick = () => { fc.remove(o); commit(); renderPanel(); };
      pn.appendChild(it);
    });
  },
  ai(pn) {
    const key = AI.hasKey();
    pn.appendChild(h(`<div><div class="sec">Magic: one tap, on-device, no key needed</div>
      <div class="hscroll"><button class="chip ${S.cur.edit.auto ? 'on' : ''}" id="mAuto">${icon('wand')} Auto-enhance</button>
      <button class="chip" id="mBg">${icon('sparkle')} Remove background</button>
      <button class="chip" id="mAll">${icon('copy')} Apply edits to all (${S.photos.length})</button></div>
      <div class="sec">AI Assistant ${key ? `<span class="tag ${AI.providerInfo(AI.loadSettings().provider).badge === 'Free' ? 'free' : ''}">${AI.providerInfo(AI.loadSettings().provider).label} · ${AI.providerInfo(AI.loadSettings().provider).badge || 'custom'}</span>` : '<span class="tag">optional</span>'}</div>
      ${key ? '' : '<p class="note">Say or type what you want and the assistant does the edits. It needs an API key: <b>Google Gemini</b> and <b>Groq</b> are free (no credit card). Tap AI settings to set one up. Everything else works without it.</p>'}
      <div class="seg ai-target" id="aiTarget"><button data-t="one" class="${S.aiTarget !== 'all' ? 'on' : ''}">This photo</button><button data-t="all" class="${S.aiTarget === 'all' ? 'on' : ''}">All photos (${S.photos.length})</button></div>
      <textarea id="aiInput" rows="2" placeholder="e.g. remove the background, put a beach behind me and add the words Summer 2026 at the top"></textarea>
      <div class="row"><button class="chip primary" id="aiGo" ${key ? '' : 'disabled'}>${icon('send')} Do it</button>
      ${AI.speechSupported() ? `<button class="chip mic" id="aiMic">${icon('mic')} Speak</button>` : ''}
      <button class="chip" id="aiSet">${icon('settings')} AI settings</button></div>
      <div class="sec ex-sec">Try one (tap to fill in)</div><div class="hscroll ex-row" id="aiEx"></div>
      <div id="aiOut"></div></div>`));
    $('#mAuto', pn).onclick = () => magicAuto();
    $('#mBg', pn).onclick = () => removeBg('precise');
    $('#mAll', pn).onclick = () => applyToAllSheet();
    $('#aiSet', pn).onclick = () => aiSettingsSheet();
    ['Make it brighter and more colorful', 'Black and white, square crop', 'Blur the background', 'Warm sunset look with a ☀️ stamp top right', 'Add “Best Day Ever” at the bottom', 'Remove the background and put a soft blue gradient behind'].forEach(x => {
      const b = h(`<button class="chip ex"></button>`); b.textContent = x; b.onclick = () => { $('#aiInput').value = x; S.aiDraft = x; if (!MANUAL) $('#aiInput').focus({ preventScroll: true }); }; $('#aiEx', pn).appendChild(b);
    });
    const ai = $('#aiInput', pn); ai.value = S.aiDraft || ''; ai.addEventListener('input', () => { S.aiDraft = ai.value; });
    $$('#aiTarget button', pn).forEach(b => b.onclick = () => { S.aiTarget = b.dataset.t; $$('#aiTarget button', pn).forEach(x => x.classList.toggle('on', x === b)); });
    $('#aiGo', pn).onclick = () => runAssistant($('#aiInput').value.trim(), S.aiTarget === 'all' ? 'all' : 'one');
    const mic = $('#aiMic', pn);
    if (mic) mic.onclick = () => {
      if (S.stopDictation) { S.stopDictation(); return; }
      mic.classList.add('on');
      try {
        S.stopDictation = AI.dictate((txt) => { $('#aiInput').value = txt; S.aiDraft = txt; }, (err) => { mic.classList.remove('on'); S.stopDictation = null; if (err && err !== 'no-speech' && err !== 'aborted') toast('Mic: ' + err); });
      } catch (e) { mic.classList.remove('on'); toast('Dictation not available'); }
    };
    if (S.aiLast) showAIOut(S.aiLast.msg, S.aiLast.err);
  },
};
function showAIOut(msg, err) { const o = $('#aiOut'); S.aiLast = { msg, err }; if (!o) return; o.innerHTML = ''; const d = h(`<div class="ai-out ${err ? 'err' : ''}"></div>`); d.textContent = msg; o.appendChild(d); }

// ---------------- overlays ----------------
const NAMED = { top: [0.5, 0.12], bottom: [0.5, 0.88], center: [0.5, 0.5], middle: [0.5, 0.5], left: [0.2, 0.5], right: [0.8, 0.5], 'top-left': [0.2, 0.12], 'top-right': [0.8, 0.12], 'bottom-left': [0.2, 0.88], 'bottom-right': [0.8, 0.88],
  'top-center': [0.5, 0.12], 'bottom-center': [0.5, 0.88], 'center-left': [0.2, 0.5], 'center-right': [0.8, 0.5] };
function resolvePos(pos) {
  if (pos && typeof pos === 'object' && 'x' in pos) return [Math.min(1, Math.max(0, +pos.x || 0)), Math.min(1, Math.max(0, +pos.y || 0))];
  if (typeof pos === 'string') return NAMED[pos.toLowerCase().trim().replace(/[\s_]+/g, '-')] || NAMED.center;
  return NAMED.center;
}
function placeObj(o, pos, sizeFrac, by = 'width') {
  const d = P.outDims(S.cur.w, S.cur.h, S.cur.edit);
  const [x, y] = resolvePos(pos);
  const target = (by === 'width' ? d.w : d.h) * sizeFrac;
  const k = target / (by === 'width' ? o.width : o.height);
  o.set({ originX: 'center', originY: 'center', scaleX: k, scaleY: k });
  o.setPositionByOrigin(new fabric.Point(x * d.w, y * d.h), 'center', 'center');
  o.setCoords();
  const br = o.getBoundingRect(true, true);
  let dx = 0, dy = 0;
  if (br.width < d.w) { if (br.left < 0) dx = -br.left; else if (br.left + br.width > d.w) dx = d.w - br.left - br.width; }
  if (br.height < d.h) { if (br.top < 0) dy = -br.top; else if (br.top + br.height > d.h) dy = d.h - br.top - br.height; }
  o.set({ left: o.left + dx, top: o.top + dy }); o.setCoords();
}
function addImageObj(url, props, opts = {}) {
  return new Promise(res => fabric.Image.fromURL(url, (img) => {
    if (!img || !img.width) { toast('Could not load that image'); return res(null); }
    img.set(props);
    placeObj(img, opts.position || 'center', opts.size || 0.3, 'width');
    if (opts.angle) img.rotate(+opts.angle);
    fc.add(img);
    if (!opts.silent) { fc.setActiveObject(img); commit(); toast('Drag to move · pinch or handles to resize/rotate'); }
    fc.requestRenderAll(); res(img);
  }));
}
const emojiCache = {};
function addEmoji(ch, opts = {}) { emojiCache[ch] ||= emojiDataURL(ch); return addImageObj(emojiCache[ch], { kind: 'stamp', name: ch }, { size: 0.22, ...opts }); }
async function loadFont(f) { try { await document.fonts.load(`${f.weight || 400} 40px ${f.css}`); } catch (e) {} }
async function addText(text, opts = {}) {
  const f = FONTS.find(x => x.name.toLowerCase() === String(opts.font || '').toLowerCase()) || (!opts.ai && FONTS.find(x => x.css === S.textStyle?.fontFamily)) || FONTS[0];
  await loadFont(f);
  const d = P.outDims(S.cur.w, S.cur.h, S.cur.edit);
  const size = Math.round(d.h * 0.09);
  const style = { fontFamily: f.css, fontWeight: f.weight || 400, fill: '#ffffff', textAlign: 'center', kind: 'text', name: 'Text', fontSize: size, lineHeight: 1.05,
    stroke: '#000000', strokeWidth: size * 0.07, paintFirst: 'stroke', strokeLineJoin: 'round', padding: 10 };
  if (!opts.ai && S.textStyle) {
    const ts = { ...S.textStyle };
    if (ts.stroke === null) { style.stroke = null; style.strokeWidth = 0; } else if (ts.stroke) style.stroke = ts.stroke;
    delete ts.stroke; delete ts.strokeWidth; delete ts.fontFamily; delete ts.fontWeight;
    if (ts.shadow) ts.shadow = new fabric.Shadow({ color: 'rgba(0,0,0,0.6)', blur: size * 0.15, offsetX: size * 0.04, offsetY: size * 0.04 });
    Object.assign(style, ts);
  }
  if (opts.ai) {
    if (opts.bold) style.fontWeight = 900;
    if (opts.color) style.fill = opts.color;
    if (opts.outline === false) { style.stroke = null; style.strokeWidth = 0; }
    if (opts.outlineColor) style.stroke = opts.outlineColor;
    if (opts.shadow) style.shadow = new fabric.Shadow({ color: 'rgba(0,0,0,0.6)', blur: size * 0.15, offsetX: size * 0.04, offsetY: size * 0.04 });
    if (opts.background) style.backgroundColor = opts.background;
  }
  const t = new fabric.Text(text, style);
  let frac = opts.size ? Math.min(0.4, Math.max(0.02, +opts.size)) : 0.09;
  placeObj(t, opts.position || 'center', frac, 'height');
  if (t.getScaledWidth() > d.w * 0.92) { frac *= (d.w * 0.92) / t.getScaledWidth(); placeObj(t, opts.position || 'center', frac, 'height'); }
  if (opts.angle) t.rotate(+opts.angle);
  fc.add(t);
  if (!opts.silent) { fc.setActiveObject(t); commit(); }
  fc.requestRenderAll();
  return t;
}
$('#fileStamp').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const img = await decodeBlob(f);
    const c = P.scaleToMax(img, 900);
    const url = c.toDataURL(/png|webp|gif/.test(f.type) ? 'image/png' : 'image/jpeg', 0.9);
    const id = 'stamp-' + uid(); S.assets.set(id, { img: c, kind: 'stamp', url });
    DB.put('assets', { id, kind: 'stamp', url });
    await addImageObj(url, { kind: 'stamp', name: 'My stamp' }, { size: 0.35 });
    renderPanel();
  } catch (err) { toast(err.message); }
};
$('#fileBgImage').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const img = await decodeBlob(f);
    const id = await addAsset(P.scaleToMax(img, 2400), 'bgimg');
    S.cur.edit.bg.imageId = id; S.cur.edit.bg.mode = 'image';
    await renderBase(); commit(); renderPanel();
  } catch (err) { toast(err.message); }
};

// ---------------- magic ----------------
async function magicAuto() {
  const p = S.cur; if (!p) return;
  if (p.edit.auto) { p.edit.auto = null; toast('Auto-enhance off'); }
  else { p.edit.auto = P.computeAutoLevels(await getPreview(p)); toast('Auto-enhanced ✨'); }
  await renderBase(); commit(); renderPanel();
}
async function computeMask(p, method) {
  try { const m = await segment(await getPreview(p), method, (msg) => busy(true, msg)); DBG.push('mask', { ok: true, ...segRun }); return m; }
  catch (e) { DBG.push('mask', { ok: false, error: e.message, ...segRun }); throw e; }
}
const NO_SUBJECT_RE = /No person|No clear|Could not separate/;
// Ensure the photo has a valid subject mask. Returns true when one is available; never changes the photo otherwise.
async function ensureMask(p) {
  const bg = p.edit.bg;
  if (bg.maskId && bg.method === 'precise') { await ensureAsset(bg.maskId); if (maskOf(p.edit)) return true; }
  const mask = await computeMask(p, 'precise');
  const id = await addAsset(mask, 'mask');
  p.edit.bg = { ...p.edit.bg, maskId: id, method: mask.method || 'precise' };
  return true;
}
// Atomic background change: the mask is computed and validated first; only then is the new background applied.
async function applyBackground(p, spec, log) {
  const before = clone(p.edit.bg);
  if (spec.type === 'none') { p.edit.bg = { ...before, mode: 'none' }; return true; }
  try { await ensureMask(p); }
  catch (e) {
    p.edit.bg = before;
    log?.push(NO_SUBJECT_RE.test(e.message) ? `• ${e.message}, so the background was left as it was.` : `• Background removal didn't work (${e.message}). The photo was left unchanged.`);
    return false;
  }
  const bg = { ...p.edit.bg };
  if (spec.type === 'color') { bg.mode = 'color'; bg.color = spec.color || '#ffffff'; }
  else if (spec.type === 'gradient') { bg.mode = 'gradient'; bg.c1 = spec.color1 || '#4facfe'; bg.c2 = spec.color2 || '#00f2fe'; bg.angle = spec.angle ?? 180; }
  else if (spec.type === 'blur') { bg.mode = 'blur'; bg.blur = Math.max(4, Math.min(80, +spec.blur || 30)); }
  else if (spec.type === 'transparent') bg.mode = 'transparent';
  else if (spec.type === 'generate') {
    let ok = false;
    if (AI.imageGenAvailable()) {
      busy(true, 'Generating a background image…');
      try {
        const blob = await AI.generateImage(spec.prompt || 'beautiful scenic background, photorealistic, no people');
        const img = await decodeBlob(blob);
        bg.imageId = await addAsset(P.scaleToMax(img, 2400), 'bgimg'); bg.mode = 'image'; ok = true;
        log?.push('• Generated a new background image.');
      } catch (err) { log?.push('• Image generation failed (' + err.message + '), used a matching gradient instead.'); }
    } else log?.push('• This AI provider can’t generate pictures, so a matching gradient was used.');
    if (!ok) { bg.mode = 'gradient'; bg.c1 = spec.color1 || '#6ec6ff'; bg.c2 = spec.color2 || '#f5d9a6'; bg.angle = 180; }
  } else { log?.push('• Unknown background type, left unchanged.'); return false; }
  p.edit.bg = bg; // single assignment: mask + new background together
  return true;
}
async function removeBg(method = 'precise', silent) {
  const p = S.cur;
  busy(true, 'Preparing background removal…');
  try {
    const log = [];
    const ok = await applyBackground(p, { type: 'transparent' }, log);
    if (!ok) { const m = (log[0] || 'Background removal failed').replace(/^• /, ''); if (silent) throw new Error(m); toast(m, 5000); return false; }
    await renderBase();
    if (!silent) { commit(); if (!MANUAL) { toast('Background removed. Ask the AI for a new one, e.g. “sunset gradient behind”'); renderPanel(); } else { toast('Background removed. Pick a new one below'); if (S.tool !== 'bg') selectTool('bg'); else renderPanel(); } }
    return true;
  } finally { busy(false); }
}
function applyToAllSheet() {
  if (S.photos.length < 2) { toast('Add more photos first. This copies the current look to every photo'); return; }
  openSheet(`<h3>Apply this photo's edits to all ${S.photos.length} photos</h3>
    <label class="row"><input type="checkbox" id="aaLook" checked> Adjustments, filter & auto-enhance</label>
    <label class="row"><input type="checkbox" id="aaBg" ${S.cur.edit.bg.maskId && S.cur.edit.bg.mode !== 'none' ? 'checked' : 'disabled'}> Background (runs removal on each photo)</label>
    <label class="row"><input type="checkbox" id="aaOv" ${fc.getObjects().length ? 'checked' : 'disabled'}> Text & stamps (same relative position)</label>
    <label class="row"><input type="checkbox" id="aaCrop"> Crop shape & rotation</label>
    <div class="actions"><button class="big-btn primary" id="aaGo">Apply to all</button><button class="big-btn" id="aaCancel">Cancel</button></div>`, (sh) => {
    $('#aaCancel', sh).onclick = closeSheet;
    $('#aaGo', sh).onclick = () => { const o = { look: $('#aaLook', sh).checked, bg: $('#aaBg', sh).checked, ov: $('#aaOv', sh).checked, crop: $('#aaCrop', sh).checked }; closeSheet(); applyToAll(o); };
  });
}
async function applyToAll(o) {
  const src = S.cur; src.overlays = currentOverlays();
  const sd = P.outDims(src.w, src.h, src.edit);
  let n = 0; const skipped = [];
  for (const p of S.photos) {
    if (p === src) continue;
    n++; busy(true, `Applying to photo ${n} of ${S.photos.length - 1}…`);
    try {
      if (!p.hist.length) { p.hist = [{ edit: clone(p.edit), overlays: clone(p.overlays) }]; p.hi = 0; }
      const e = p.edit;
      if (o.look) { e.adj = { ...src.edit.adj }; e.filter = src.edit.filter; e.filterAmt = src.edit.filterAmt; e.auto = src.edit.auto ? P.computeAutoLevels(await getPreview(p)) : null; }
      if (o.crop) {
        e.orient = { ...src.edit.orient };
        const g = P.geomDims(p.w, p.h, e.orient), sg = P.geomDims(src.w, src.h, src.edit.orient);
        if (src.edit.crop.w === 1 && src.edit.crop.h === 1) e.crop = { x: 0, y: 0, w: 1, h: 1 };
        else { const a = (sg.w * src.edit.crop.w) / (sg.h * src.edit.crop.h); let w = 1, hh = (g.w / a) / g.h; if (hh > 1) { hh = 1; w = (g.h * a) / g.w; } e.crop = { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh }; }
      }
      if (o.bg) {
        try { const mask = await computeMask(p, 'precise'); const id = await addAsset(mask, 'mask'); e.bg = { ...clone(src.edit.bg), maskId: id, method: mask.method || 'precise' }; }
        catch (err) { skipped.push(S.photos.indexOf(p) + 1); }
      }
      if (o.ov) {
        const td = P.outDims(p.w, p.h, e), kx = td.w / sd.w, ky = td.h / sd.h, ks = Math.min(kx, ky);
        p.overlays = src.overlays.map(ob => ({ ...clone(ob), left: ob.left * kx, top: ob.top * ky, scaleX: ob.scaleX * ks, scaleY: ob.scaleY * ks }));
      }
      p.hist.push({ edit: clone(e), overlays: clone(p.overlays) }); p.hi = p.hist.length - 1; p.edited = true;
      p.thumb = (await renderComposite(p, 360)).toDataURL('image/jpeg', 0.8);
      p.prev = null;
      savePhoto(p, true);
    } catch (err) { console.error(err); toast(`Photo ${n}: ${err.message}`); }
  }
  busy(false); toast(`Applied to ${n} photo${n > 1 ? 's' : ''} ✓` + (skipped.length ? `. Background kept on photo ${skipped.join(', ')} (no subject found)` : ''), 4000);
}

// ---------------- AI assistant ----------------
function aiContext() {
  const p = S.cur, d = P.outDims(p.w, p.h, p.edit);
  return {
    image: { width: d.w, height: d.h, orientation: d.w >= d.h ? 'landscape' : 'portrait' },
    edits: { adjust: p.edit.adj, filter: p.edit.filter, autoEnhance: !!p.edit.auto, backgroundRemoved: !!p.edit.bg.maskId, background: p.edit.bg.mode, cropped: p.edit.crop.w < 1 || p.edit.crop.h < 1 },
    currentOverlays: fc.getObjects().map((o, i) => { const c = o.getCenterPoint(); return { index: i, type: o.kind || 'stamp', text: o.text, name: o.name, x: +(c.x / d.w).toFixed(2), y: +(c.y / d.h).toFixed(2) }; }),
    photosInSession: S.photos.length,
  };
}
async function runAssistant(req, target = 'one') {
  if (!req) { toast('Type or say what you want'); return; }
  if (!AI.hasKey()) { aiSettingsSheet(); return; }
  const home = S.cur;
  const targets = target === 'all' ? S.photos.slice() : [home];
  busy(true, 'Asking the AI…');
  const proposal = [], logs = [];
  try {
    const plan = await AI.plan(req, { ...aiContext(), target: target === 'all' ? `all ${targets.length} photos, same steps applied to each` : 'this photo only' });
    console.log('AI plan', plan);
    DBG.push('ai', { request: req.slice(0, 300), target, provider: plan.provider, model: plan.model, message: plan.message, rawCommands: JSON.stringify(plan.rawCommands).slice(0, 2500), commands: JSON.stringify(plan.commands).slice(0, 2500), warnings: plan.warnings });
    (plan.warnings || []).forEach(w => logs.push('• Note: ' + w));
    if (!plan.commands.length) { showAIOut(plan.message || 'The AI had no edits to make for that request.'); return; }
    S.aiRunning = true;
    // current photo first, then the rest
    const order = [home, ...targets.filter(p => p !== home)];
    let i = 0;
    for (const p of order) {
      i++;
      busy(true, targets.length > 1 ? `Applying AI edits to photo ${i} of ${targets.length}…` : 'Applying edits…');
      if (S.cur !== p) await openEditor(p, { keepBusy: true });
      proposal.push({ p, hi: p.hi });
      const log = await executeCommands(plan.commands);
      log.forEach(l => logs.push(targets.length > 1 ? `Photo ${S.photos.indexOf(p) + 1}: ${l.replace(/^• /, '')}` : l));
    }
    if (S.cur !== home) await openEditor(home, { keepBusy: true });
    S.aiProposal = proposal;
    showAIBar(proposal.length, plan.message);
    showAIOut((plan.message || 'Done.') + (logs.length ? '\n' + logs.join('\n') : ''));
    DBG.push('ai-result', { log: logs.slice(0, 20), bg: S.cur && { mode: S.cur.edit.bg.mode, hasMask: !!S.cur.edit.bg.maskId, method: S.cur.edit.bg.method } });
  } catch (e) { console.error(e); DBG.push('ai-error', { request: req.slice(0, 300), error: e.message }); showAIOut('AI error: ' + e.message, true); }
  finally { S.aiRunning = false; busy(false); }
}
function showAIBar(n, msg) {
  $('#aiBarText').textContent = n > 1 ? `AI edited ${n} photos. Review, then keep or undo.` : 'AI made these changes. Review, then keep or undo.';
  $('#aiBar').classList.add('on'); requestAnimationFrame(layout);
}
function hideAIBar() { S.aiProposal = null; $('#aiBar').classList.remove('on'); requestAnimationFrame(layout); }
$('#aiKeep').onclick = () => { const n = S.aiProposal?.length || 1; hideAIBar(); toast(n > 1 ? `Kept AI edits on ${n} photos` : 'Kept. Everything stays editable'); };
$('#aiUndo').onclick = async () => {
  const prop = S.aiProposal; if (!prop) return;
  busy(true, 'Undoing AI edits…');
  try {
    for (const { p, hi } of prop) {
      if (p === S.cur) { await restore(hi); continue; }
      const snap = p.hist[hi]; if (!snap) continue;
      p.edit = clone(snap.edit); p.overlays = clone(snap.overlays); p.hi = hi; p.edited = hi > 0;
      try { p.thumb = (await renderComposite(p, 360)).toDataURL('image/jpeg', 0.8); } catch (e) {}
      p.prev = null; savePhoto(p, true);
    }
  } finally { busy(false); }
  hideAIBar(); updateUndo(); toast(prop.length > 1 ? `Undid AI edits on ${prop.length} photos` : 'AI edits undone');
};
$('#aiManual').onclick = () => {
  hideAIBar(); selectTool('layers');
  toast('AI changes are normal edits: tap any text or stamp to move or change it, or use the tools');
};
async function executeCommands(cmds) {
  const p = S.cur, log = [];
  if (S.mode !== 'select') setMode('select');
  const e = () => p.edit;
  const cv = (v) => Math.max(-100, Math.min(100, Math.round(+v || 0)));
  for (const c of cmds || []) {
    if (!c || typeof c !== 'object') continue;
    try {
      switch (c.op) {
        case 'autoEnhance': e().auto = P.computeAutoLevels(await getPreview(p)); break;
        case 'adjust': ['brightness', 'contrast', 'saturation', 'warmth', 'sharpness'].forEach(k => { if (c[k] != null) e().adj[k] = cv(c[k]); }); break;
        case 'filter': if (P.FILTERS[c.name]) { e().filter = c.name; e().filterAmt = c.amount != null ? Math.max(0, Math.min(100, +c.amount)) : 100; } else log.push(`• Unknown filter “${c.name}”.`); break;
        case 'rotate': geomOp(c.direction === 'ccw' ? 'ccw' : 'cw', true); break;
        case 'flip': geomOp(c.axis === 'v' ? 'v' : 'h', true); break;
        case 'resetCrop': setCrop({ x: 0, y: 0, w: 1, h: 1 }); break;
        case 'crop': {
          if (c.aspect === 'original') setCrop({ x: 0, y: 0, w: 1, h: 1 });
          else if (c.aspect) { const [a, b] = String(c.aspect).split(':').map(Number); if (a && b) setCrop(aspectCrop(a / b)); }
          else if (c.w && c.h) { const x = Math.max(0, Math.min(0.95, +c.x || 0)), y = Math.max(0, Math.min(0.95, +c.y || 0)); setCrop({ x, y, w: Math.min(1 - x, +c.w), h: Math.min(1 - y, +c.h) }); }
          break;
        }
        case 'removeBackground': await applyBackground(p, { type: 'transparent' }, log); break;
        case 'setBackground': await applyBackground(p, c, log); break;
        case 'addText': if (c.text) await addText(String(c.text).slice(0, 200), { ...c, ai: true, silent: true }); break;
        case 'addStamp': if (c.emoji) await addEmoji(String(c.emoji), { position: c.position, size: Math.min(0.8, Math.max(0.03, +c.size || 0.2)), angle: c.angle, silent: true }); break;
        case 'updateObject': {
          const o = fc.getObjects()[c.index]; if (!o) break;
          if (c.text != null && o.kind === 'text') o.set({ text: String(c.text) });
          if (c.color && o.kind === 'text') o.set({ fill: c.color });
          if (c.angle != null) o.rotate(+c.angle);
          if (c.position || c.size) { const d = P.outDims(p.w, p.h, e()); const ctr = o.getCenterPoint(); const isT = o.kind === 'text'; placeObj(o, c.position || { x: ctr.x / d.w, y: ctr.y / d.h }, +c.size || (isT ? o.getScaledHeight() / d.h : o.getScaledWidth() / d.w), isT ? 'height' : 'width'); }
          o.setCoords(); break;
        }
        case 'deleteObject': { const o = fc.getObjects()[c.index]; if (o) fc.remove(o); break; }
        case 'clearOverlays': fc.getObjects().slice().forEach(o => fc.remove(o)); break;
        case 'resetAll': { const keep = p.edit.bg; p.edit = P.defaultEdit(); if (keep.maskId) p.edit.bg = { ...p.edit.bg, maskId: keep.maskId, method: keep.method }; fc.getObjects().slice().forEach(o => fc.remove(o)); break; }
        default: log.push(`• Skipped unknown step “${c.op}”.`);
      }
    } catch (err) { (NO_SUBJECT_RE.test(err.message) ? console.warn : console.error)(err); log.push(`• ${c.op} failed: ${err.message}`); }
  }
  layout(); await renderBase(); commit(); if (S.tool && S.tool !== 'ai') renderPanel();
  return log;
}

function aiSettingsSheet() {
  const cur = AI.loadSettings();
  const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const cards = Object.entries(AI.PROVIDERS).map(([k, v]) => `<button class="prov ${cur.provider === k ? 'on' : ''}" data-p="${k}">
      <span class="prov-name">${v.label}${k === AI.DEFAULT_PROVIDER ? ' <span class="tag free">Recommended</span>' : ''}</span>
      <span class="tag ${v.badge === 'Free' ? 'free' : v.badge === 'Paid' ? 'paid' : ''}">${v.badge || 'Custom'}</span>${cur.provider === k ? '<span class="prov-active">In use</span>' : ''}</button>`).join('');
  openSheet(`<h3>AI settings <span class="tag">optional</span></h3>
    <p class="note">The AI Assistant is optional. It uses <b>your own key</b>, stored only in this browser and sent only to the provider you pick. <b>Google Gemini</b> and <b>Groq</b> have free tiers (no credit card).</p>
    <div class="prov-list" id="aiProv">${cards}</div>
    <div class="note prov-note" id="aiProvNote"></div>
    <label class="fld" for="aiKey">API key for <span id="aiProvName"></span> (stored only on this device)</label>
    <input type="password" id="aiKey" autocomplete="off" spellcheck="false">
    <div class="row"><button class="chip primary" id="aiTest">Test key</button><button class="chip" id="aiShow">Show</button><a class="chip" id="aiGetKey" target="_blank" rel="noopener">Get a key ↗</a></div>
    <div id="aiTestOut"></div>
    <details id="aiAdv"><summary class="fld" style="cursor:pointer">Advanced (base URL, models)</summary>
      <label class="fld" for="aiBase">Base URL (OpenAI-compatible)</label><input type="url" id="aiBase">
      <label class="fld" for="aiModel">Chat model</label><input type="text" id="aiModel">
      <label class="fld" for="aiImgModel">Image model for AI backgrounds (blank = off, gradients used)</label><input type="text" id="aiImgModel">
      <label class="row"><input type="checkbox" id="aiImgOn"> Allow generated backgrounds (text-to-image)</label>
    </details>
    <div class="warn">Only paste a key on your own phone. Anyone using this browser could use it. “Forget key” removes it.</div>
    <div class="actions"><button class="big-btn primary" id="aiSave">Use this provider</button><button class="big-btn" id="aiForget">Forget this key</button></div>
    <div class="actions"><button class="big-btn" id="aiReport">Report a problem</button></div>`, (sh) => {
    $('#aiReport', sh).addEventListener('click', reportProblem);
    let prov = cur.provider;
    const fill = (id) => {
      const st = AI.loadSettings(id), P = AI.providerInfo(id);
      $('#aiKey', sh).value = st.apiKey; $('#aiKey', sh).placeholder = P.keyHint ? `paste your key, e.g. ${P.keyHint}` : 'paste your API key';
      $('#aiBase', sh).value = st.baseUrl; $('#aiModel', sh).value = st.model; $('#aiImgModel', sh).value = st.imageModel; $('#aiImgOn', sh).checked = !!st.imageGen;
      $('#aiProvName', sh).textContent = P.label;
      $('#aiProvNote', sh).textContent = P.note;
      const gk = $('#aiGetKey', sh); gk.style.display = P.keyUrl ? '' : 'none'; gk.href = P.keyUrl || '#';
      $('#aiAdv', sh).open = id === 'custom';
      $('#aiSave', sh).textContent = id === st.active ? 'Save' : `Switch to ${P.label}`;
      $('#aiTestOut', sh).innerHTML = '';
    };
    fill(prov);
    $$('#aiProv .prov', sh).forEach(b => b.onclick = () => { prov = b.dataset.p; $$('#aiProv .prov', sh).forEach(x => x.classList.toggle('on', x === b)); fill(prov); });
    const draft = () => ({ provider: prov, apiKey: $('#aiKey', sh).value.trim(), baseUrl: $('#aiBase', sh).value.trim(), model: $('#aiModel', sh).value.trim(), imageModel: $('#aiImgModel', sh).value.trim(), imageGen: $('#aiImgOn', sh).checked });
    $('#aiShow', sh).onclick = (e) => { const k = $('#aiKey', sh); k.type = k.type === 'password' ? 'text' : 'password'; e.currentTarget.textContent = k.type === 'password' ? 'Show' : 'Hide'; };
    $('#aiSave', sh).onclick = () => {
      const d = draft(); AI.saveSettings(d, true); closeSheet();
      toast(`AI Assistant now uses ${AI.providerInfo(prov).label}${d.apiKey ? '' : ' (add a key to use it)'}`);
      if (S.tool === 'ai') renderPanel();
    };
    $('#aiTest', sh).onclick = async (e) => {
      const btn = e.currentTarget, o = $('#aiTestOut', sh);
      btn.disabled = true; o.innerHTML = '<div class="ai-out">Checking your key…</div>';
      const r = await AI.testKey(draft());
      btn.disabled = false;
      o.innerHTML = ''; const d = h(`<div class="ai-out ${r.ok ? '' : 'err'}"></div>`);
      const active = AI.loadSettings().active;
      d.textContent = (r.ok ? '✓ ' : '✗ ') + r.message + (r.ok && prov !== active ? ` Key saved. Tap “Switch to ${AI.providerInfo(prov).label}” to start using it.` : '');
      o.appendChild(d);
      if (r.ok) { AI.saveSettings(draft(), prov === active); if (S.tool === 'ai') renderPanel(); }
    };
    $('#aiForget', sh).onclick = () => { AI.clearKey(prov); $('#aiKey', sh).value = ''; $('#aiTestOut', sh).innerHTML = ''; toast(`${AI.providerInfo(prov).label} key removed from this device`); if (S.tool === 'ai') renderPanel(); };
  });
}

// ---------------- export ----------------
function looksBlank(c) {
  try {
    const t = P.makeCanvas(32, 32), x = t.getContext('2d'); x.drawImage(c, 0, 0, 32, 32);
    const d = x.getImageData(0, 0, 32, 32).data; let a = 0; for (let i = 3; i < d.length; i += 4) a += d[i];
    P.freeCanvas(t); return a === 0;
  } catch (e) { return true; }
}
// Renders the final image; if the browser runs out of canvas memory (blank result, common on iPhone), retries smaller.
async function renderComposite(p, maxSide, jpeg) {
  const sizes = [maxSide || null, 3072, 2048].filter((v, i, a) => i === 0 || (v < (maxSide || Infinity) && a.indexOf(v) === i));
  let last;
  for (const ms of sizes) {
    try { const c = await renderCompositeOnce(p, ms, jpeg); if (!looksBlank(c)) return c; P.freeCanvas(c); last = new Error('render came out blank'); }
    catch (e) { last = e; }
    DBG.push('render', { msg: `render at ${ms || 'full'} failed: ${last.message}` });
  }
  throw new Error('Could not render the photo (the phone ran out of memory). Try closing other tabs.');
}
async function renderCompositeOnce(p, maxSide, jpeg) {
  if (S.cur === p && fc) p.overlays = currentOverlays();
  const src = maxSide ? P.scaleToMax(await getPreview(p), maxSide) : await getFull(p);
  await ensureAssets(p.edit);
  const base = P.render(src, p.edit, maskOf(p.edit), S.assets);
  const d = P.outDims(p.w, p.h, p.edit);
  const k = base.width / d.w;
  const sc = new fabric.StaticCanvas(null, { width: base.width, height: base.height, enableRetinaScaling: false, renderOnAddRemove: false });
  (await enliven(p.overlays)).forEach(o => sc.add(o));
  sc.setViewportTransform([k, 0, 0, k, 0, 0]);
  sc.backgroundImage = new fabric.Image(base, { left: 0, top: 0, originX: 'left', originY: 'top', scaleX: 1 / k, scaleY: 1 / k, objectCaching: false });
  if (jpeg) sc.backgroundColor = '#ffffff';
  sc.renderAll();
  const out = P.makeCanvas(base.width, base.height);
  out.getContext('2d').drawImage(sc.getElement(), 0, 0);
  sc.dispose();
  if (base !== src) P.freeCanvas(base);
  return out;
}
function fname(i, ext) { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `photo-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}${i != null ? '-' + (i + 1) : ''}.${ext}`; }
async function exportFiles(list) {
  const { format, quality } = S.exp, png = format === 'png', mime = png ? 'image/png' : 'image/jpeg', ext = png ? 'png' : 'jpg';
  const files = [];
  try {
    for (let i = 0; i < list.length; i++) {
      busy(true, list.length > 1 ? `Rendering ${i + 1} of ${list.length} at full resolution…` : 'Rendering full resolution…');
      await sleep(20);
      const c = await renderComposite(list[i], null, !png);
      const blob = await new Promise(r => c.toBlob(r, mime, quality));
      files.push(new File([blob], fname(list.length > 1 ? i : null, ext), { type: mime, lastModified: Date.now() }));
      c.width = c.height = 1;
    }
  } finally { busy(false); }
  S.lastExport = files;
  return files;
}
function download(files) {
  files.forEach((f, i) => setTimeout(() => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, i * 400));
}
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canShareFiles = (files) => { try { return !!navigator.canShare && navigator.canShare({ files }); } catch (e) { return false; } };
async function share(files, btn) {
  try { await navigator.share({ files }); return true; }
  catch (e) {
    if (e.name === 'AbortError') return true;
    if (e.name === 'NotAllowedError' && btn) { btn.textContent = 'Ready: tap again to share'; btn.onclick = () => share(files); return false; }
    toast('Sharing not available here, downloading instead'); download(files); return true;
  }
}
// ---------------- preview & approve ----------------
const PV = { items: [], idx: 0, from: 'gallery', busy: false };
function pvRevoke() { PV.items.forEach(it => { URL.revokeObjectURL(it.url); URL.revokeObjectURL(it.beforeUrl); }); }
async function pvRender() {
  const list = PV.items.length ? PV.items.map(it => it.p) : PV.list;
  const keep = new Map(PV.items.map(it => [it.p, it.on]));
  const files = await exportFiles(list);
  pvRevoke();
  PV.items = list.map((p, i) => ({ p, file: files[i], url: URL.createObjectURL(files[i]), beforeUrl: URL.createObjectURL(p.blob), on: keep.has(p) ? keep.get(p) : true }));
}
async function openPreview(list, from) {
  list = (list || []).filter(Boolean);
  if (!list.length) return;
  if (S.cur && fc) { fc.discardActiveObject(); fc.requestRenderAll(); S.cur.overlays = currentOverlays(); savePhoto(S.cur); }
  PV.from = from; PV.list = list; PV.items = []; PV.idx = Math.max(0, list.indexOf(S.cur));
  try { await pvRender(); } catch (e) { console.error(e); toast('Could not render: ' + e.message); return; }
  showScreen('preview');
  $('#pvTrack').classList.remove('show-before'); $('#pvBefore').setAttribute('aria-pressed', 'false');
  pvBuild();
  requestAnimationFrame(() => { const t = $('#pvTrack'); t.scrollLeft = PV.idx * t.clientWidth; });
}
function pvBuild() {
  const t = $('#pvTrack'), many = PV.items.length > 1;
  t.innerHTML = '';
  PV.items.forEach((it, i) => {
    const sl = h(`<div class="pv-slide ${it.on ? '' : 'off'}"><img class="after" alt="Final photo ${i + 1}"><img class="before" alt="Original photo ${i + 1}"><span class="pv-tag">After</span>
      ${many ? `<label class="pv-inc"><input type="checkbox" ${it.on ? 'checked' : ''}> Include</label>` : ''}</div>`);
    sl.querySelector('.after').src = it.url; sl.querySelector('.before').src = it.beforeUrl;
    const cb = sl.querySelector('input');
    if (cb) cb.onchange = () => { it.on = cb.checked; sl.classList.toggle('off', !it.on); pvStatus(); };
    t.appendChild(sl);
  });
  $$('#pvFmt button').forEach(b => b.classList.toggle('on', b.dataset.f === S.exp.format));
  pvQuality(); pvStatus();
}
function pvQuality() {
  const box = $('#pvQ'); box.innerHTML = '';
  if (S.exp.format === 'jpeg') box.appendChild(slider('Quality', Math.round(S.exp.quality * 100), 50, 100, v => { S.exp.quality = v / 100; persistExp(); }, () => pvReRender()));
  else box.appendChild(h('<p class="note" style="margin:0">PNG keeps transparent backgrounds (bigger files).</p>'));
}
function pvSelected() { return PV.items.filter(it => it.on); }
function pvStatus() {
  const n = PV.items.length, k = pvSelected().length, many = n > 1;
  $('#pvCount').textContent = many ? `${PV.idx + 1} of ${n} · ${k} selected · swipe` : `${PV.items[0].file.name} · ${(PV.items[0].file.size / 1048576).toFixed(1)} MB`;
  $('#pvDots').innerHTML = many ? PV.items.map((it, i) => `<i class="${i === PV.idx ? 'on' : ''} ${it.on ? '' : 'off'}"></i>`).join('') : '';
  const sfx = many ? ` (${k})` : '';
  $('#pvSaveLbl').textContent = (isIOS && canShareFiles([PV.items[0].file]) ? 'Approve & Save to Photos' : 'Approve & Save to phone') + sfx;
  $('#pvShareLbl').textContent = 'Approve & Share to Drive / apps' + sfx;
  $('#pvSave').disabled = $('#pvShare').disabled = !k;
  $('#pvShare').style.display = canShareFiles([PV.items[0].file]) ? '' : 'none';
  $$('#pvTrack .pv-tag').forEach(tg => { tg.textContent = $('#pvTrack').classList.contains('show-before') ? 'Before' : 'After'; });
}
async function pvReRender() {
  if (PV.busy) return; PV.busy = true;
  try { await pvRender(); pvBuild(); requestAnimationFrame(() => { const t = $('#pvTrack'); t.scrollLeft = PV.idx * t.clientWidth; }); } finally { PV.busy = false; }
}
$('#pvTrack').addEventListener('scroll', () => { const t = $('#pvTrack'); const i = Math.round(t.scrollLeft / Math.max(1, t.clientWidth)); if (i !== PV.idx) { PV.idx = i; pvStatus(); } }, { passive: true });
$('#pvBefore').onclick = () => { const t = $('#pvTrack'); const on = !t.classList.contains('show-before'); t.classList.toggle('show-before', on); $('#pvBefore').setAttribute('aria-pressed', String(on)); pvStatus(); };
$$('#pvFmt button').forEach(b => b.onclick = () => { if (S.exp.format === b.dataset.f) return; S.exp.format = b.dataset.f; persistExp(); pvReRender(); });
function closePreview(toEdit) {
  const cur = PV.items[PV.idx]?.p;
  pvRevoke(); PV.items = []; $('#pvTrack').innerHTML = '';
  if (PV.from === 'editor' && S.cur) { showScreen('editor'); requestAnimationFrame(layout); if (toEdit && cur && cur !== S.cur) openEditor(cur); }
  else if (toEdit && cur) openEditor(cur);
  else { showScreen('gallery'); renderGallery(); }
}
$('#pvBack').onclick = () => closePreview(true);
$('#pvEdit').onclick = () => closePreview(true);
$('#pvSave').onclick = async (ev) => {
  const files = pvSelected().map(i => i.file); if (!files.length) return;
  S.lastApproved = files.map(f => f.name);
  if (isIOS && canShareFiles(files)) { const ok = await share(files, ev.currentTarget); if (ok) toast('Choose “Save Image” to put it in Photos'); }
  else { download(files); toast(files.length > 1 ? `Saving ${files.length} photos to your phone…` : 'Saved to your phone ✓'); }
};
$('#pvShare').onclick = async (ev) => {
  const files = pvSelected().map(i => i.file); if (!files.length) return;
  S.lastApproved = files.map(f => f.name);
  if (canShareFiles(files)) await share(files, ev.currentTarget); else { download(files); }
};

function persistExp() { localStorage.setItem('photoapp.export', JSON.stringify(S.exp)); }
$('#btnExport').onclick = () => openPreview([S.cur], 'editor');

// ---------------- boot ----------------
async function boot() {
  hydrateIcons();
  const saved = (await DB.all('photos')) || [];
  saved.sort((a, b) => a.created - b.created).forEach(r => S.photos.push({ ...r, hist: [], hi: -1 }));
  const assets = (await DB.all('assets')) || [];
  for (const a of assets) if (a.kind === 'stamp' && a.url) S.assets.set(a.id, { img: null, kind: 'stamp', url: a.url });
  renderGallery();
  if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') navigator.serviceWorker?.register('sw.js').catch(e => console.warn('SW', e));
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });
  window.__ready = true;
}
boot();
window.__app = { openPreview, runAssistant, openEditor, closeEditor, addText, addEmoji, executeCommands, renderComposite, exportFiles, importFiles, selectTool, commit, restore, removeBg, magicAuto, applyToAll, get fc() { return fc; } };
