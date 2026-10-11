// On-device background removal, loaded lazily from public CDNs (then cached by the service worker).
//  - 'precise' (default): IMG.LY ISNet. fp16 weights (~80 MB, one-time) with the 8-bit build (~40 MB) as fallback.
//    Always run on the WASM CPU backend (no WebGPU), which gave identical results on Chromium and WebKit.
//  - 'quick'  (fallback only): MediaPipe selfie multiclass (people only). GPU delegate first; if its mask
//    looks wrong it is re-run on the CPU delegate.
// Every mask is validated (coverage, solid area, inversion) before the app uses it; an invalid mask is
// never applied, so a failed run can't make the photo disappear.
import { maskFromConfidence, scaleToMax, makeCanvas, freeCanvas } from './pipeline.js';

const MP_VER = '1.1.0';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const IMGLY = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';
const SEG_MAX = 1600; // segmentation always runs on a downscaled copy (well under iOS canvas limits)

export const lastRun = { steps: [] }; // diagnostics for the "Report a problem" log (no image data)
const note = (s) => { lastRun.steps.push(s); if (lastRun.steps.length > 12) lastRun.steps.shift(); };

let vision, fileset; const mpSeg = {};
async function getMediaPipe(delegate, progress) {
  if (mpSeg[delegate]) return mpSeg[delegate];
  progress?.('Loading on-device AI model…');
  vision = vision || await import(`${MP_BASE}/vision_bundle.mjs`);
  fileset = fileset || await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  mpSeg[delegate] = await vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MP_MODEL, delegate },
    runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  });
  return mpSeg[delegate];
}
async function quickWith(delegate, canvas, progress) {
  const seg = await getMediaPipe(delegate, progress);
  progress?.('Finding the subject…');
  const input = scaleToMax(canvas, 1024);
  const res = seg.segment(input);
  freeCanvas(input);
  const masks = res.confidenceMasks;
  const m0 = masks[0];
  const w = m0.width, h = m0.height;
  const raw = m0.getAsFloat32Array();
  let conf;
  if (masks.length > 1) { conf = new Float32Array(raw.length); for (let i = 0; i < raw.length; i++) conf[i] = 1 - raw[i]; } // [0] = background class
  else conf = Float32Array.from(raw);
  masks.forEach(m => m.close && m.close());
  for (let i = 0; i < conf.length; i++) if (!(conf[i] >= 0 && conf[i] <= 1)) conf[i] = 0; // NaN / out-of-range guard (GPU)
  return maskFromConfidence(conf, w, h, canvas.width, canvas.height, 0.3, 0.7);
}
async function quick(canvas, progress) {
  let m;
  try { m = await quickWith('GPU', canvas, progress); const st = maskStats(m); if (st.ok) { note('quick GPU ok'); return m; } note('quick GPU mask rejected: ' + st.reason); }
  catch (e) { note('quick GPU failed: ' + e.message); }
  m = await quickWith('CPU', canvas, progress); note('quick CPU used');
  return m;
}

let imgly; const PRECISE_MODELS = ['isnet_fp16', 'isnet_quint8'];
const READY_KEY = 'photoapp.bgModelReady';
function alphaToMask(bmp, useLuma) {
  const c = makeCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const a = useLuma ? d[i] : d[i + 3]; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = a; }
  g.putImageData(id, 0, 0);
  return c;
}
async function precise(canvas, progress) {
  const cached = (() => { try { return localStorage.getItem(READY_KEY); } catch (e) { return null; } })();
  progress?.(cached ? 'Removing background…' : 'Getting the background model ready (one-time download, about 80 MB)…');
  if (!imgly) imgly = await import(IMGLY);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('could not prepare the photo for the model');
  let lastErr;
  for (const model of (cached === 'isnet_quint8' ? ['isnet_quint8'] : PRECISE_MODELS)) {
    try {
      const run = (type) => imgly.removeBackground(blob, {
        model, device: 'cpu', output: { format: 'image/png', type },
        progress: (key, cur, total) => {
          if (!total || !/fetch/.test(key)) return;
          const pct = Math.round((cur / total) * 100);
          progress?.(pct < 100 ? `Downloading background model (one-time, ${model === 'isnet_fp16' ? '≈80' : '≈40'} MB)… ${pct}%` : 'Removing background…');
        },
      });
      let m = alphaToMask(await createImageBitmap(await run('foreground')), false);
      let st = maskStats(m);
      if (!st.ok && st.coverage > 0.98) { // opaque cut-out (alpha lost) -> ask for the plain mask and read luminance
        note(`precise ${model}: foreground alpha unusable (${st.reason}), trying mask output`);
        freeCanvas(m); m = alphaToMask(await createImageBitmap(await run('mask')), true); st = maskStats(m);
      }
      if (!st.ok && model !== PRECISE_MODELS.at(-1)) { note(`precise ${model} rejected: ${st.reason}`); freeCanvas(m); continue; }
      try { localStorage.setItem(READY_KEY, model); } catch (e) {}
      note(`precise ${model}: coverage ${st.coverage}`);
      m.model = model;
      return m;
    } catch (e) { lastErr = e; note(`precise ${model} failed: ${e.message}`); console.warn('precise model failed', model, e); }
  }
  throw lastErr || new Error('precise model failed');
}

// Mask statistics + sanity checks on a small copy.
export function maskStats(mask, image) {
  const W = 128, H = Math.max(1, Math.round(128 * mask.height / mask.width));
  const s = makeCanvas(W, H), g = s.getContext('2d', { willReadFrequently: true });
  g.drawImage(mask, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  let im = null;
  if (image) { g.clearRect(0, 0, W, H); g.drawImage(image, 0, 0, W, H); im = g.getImageData(0, 0, W, H).data; }
  freeCanvas(s);
  let sum = 0, solid = 0, bSum = 0, bN = 0, cSum = 0, cN = 0, edges = 0;
  const A = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) A[i] = d[i * 4 + 3] / 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, a = A[i]; sum += a;
    if (a > 0.5) { solid++; if ((x > 0 && A[i - 1] <= 0.5) || (x < W - 1 && A[i + 1] <= 0.5) || (y > 0 && A[i - W] <= 0.5) || (y < H - 1 && A[i + W] <= 0.5)) edges++; }
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { bSum += a; bN++; }
    if (x > W * 0.3 && x < W * 0.7 && y > H * 0.3 && y < H * 0.7) { cSum += a; cN++; }
  }
  const n = W * H, coverage = sum / n, solidFrac = solid / n, border = bSum / bN, center = cSum / cN;
  // ragged = boundary length relative to a circle of the same area (1 = perfectly compact blob)
  const ragged = solid ? edges / (2 * Math.sqrt(Math.PI * solid)) : 0;
  const st = { coverage: +coverage.toFixed(3), solid: +solidFrac.toFixed(3), border: +border.toFixed(2), center: +center.toFixed(2), ragged: +ragged.toFixed(2), ok: true, reason: '' };
  if (im) { // how much the photo itself varies; a flat/blank picture has nothing to cut out
    let m = 0, m2 = 0; for (let i = 0; i < n; i++) { const L = 0.299 * im[i * 4] + 0.587 * im[i * 4 + 1] + 0.114 * im[i * 4 + 2]; m += L; m2 += L * L; }
    m /= n; st.imgStd = +Math.sqrt(Math.max(0, m2 / n - m * m)).toFixed(1);
  }
  if (!(coverage >= 0.02)) { st.ok = false; st.reason = 'empty'; }
  else if (coverage > 0.98) { st.ok = false; st.reason = 'everything selected'; }
  else if (solidFrac < 0.015) { st.ok = false; st.reason = 'too faint'; }
  else if (border > 0.85 && center < 0.15) { st.ok = false; st.reason = 'looks inverted'; }
  else if (st.imgStd != null && st.imgStd < 6) { st.ok = false; st.reason = 'photo has no visible subject'; }
  else if (ragged > 6) { st.ok = false; st.reason = 'mask is noisy'; }
  return st;
}
// Edge refinement (in place): drop stray specks, fill pinholes inside the subject, firm up the matte
// without shrinking it, and add a light feather. Never reduces mid-confidence subject areas.
export function refineMask(mask) {
  const w = mask.width, h = mask.height, n = w * h;
  const g = mask.getContext('2d', { willReadFrequently: true });
  const id = g.getImageData(0, 0, w, h), d = id.data;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3] / 255;
  const lab = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  const comps = [];
  for (let s = 0; s < n; s++) {
    if (lab[s] !== -1) continue;
    const fg = a[s] >= 0.35; let sp = 0, size = 0, border = false; const L = comps.length;
    stack[sp++] = s; lab[s] = L;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && lab[i - 1] === -1 && (a[i - 1] >= 0.35) === fg) { lab[i - 1] = L; stack[sp++] = i - 1; }
      if (x < w - 1 && lab[i + 1] === -1 && (a[i + 1] >= 0.35) === fg) { lab[i + 1] = L; stack[sp++] = i + 1; }
      if (y > 0 && lab[i - w] === -1 && (a[i - w] >= 0.35) === fg) { lab[i - w] = L; stack[sp++] = i - w; }
      if (y < h - 1 && lab[i + w] === -1 && (a[i + w] >= 0.35) === fg) { lab[i + w] = L; stack[sp++] = i + w; }
    }
    comps.push({ fg, size, border });
  }
  let big = 0; for (const c of comps) if (c.fg && c.size > big) big = c.size;
  const action = comps.map(c => c.fg ? (c.size < Math.min(0.01 * big, 0.002 * n) ? 'drop' : '') : (!c.border && c.size < 0.0015 * n ? 'fill' : ''));
  // matte firming: clear faint haze (<4%), make near-solid (>85%) solid, stretch the rest upward (never down)
  const firm = (t) => { const v = (t - 0.04) / 0.81; return v <= 0 ? 0 : v >= 1 ? 1 : Math.max(v, t); };
  for (let i = 0; i < n; i++) { const ac = action[lab[i]]; a[i] = ac === 'drop' ? 0 : ac === 'fill' ? 1 : firm(a[i]); }
  const r = Math.max(1, Math.round(Math.max(w, h) / 900));
  const tmp = new Float32Array(n), bl = new Float32Array(n);
  for (let y = 0; y < h; y++) { let acc = 0; const o = y * w; for (let x = -r; x <= r; x++) acc += a[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[o + x] = acc / (2 * r + 1); acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; } }
  for (let x = 0; x < w; x++) { let acc = 0; for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { bl[y * w + x] = acc / (2 * r + 1); acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
  for (let i = 0; i < n; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = Math.round(255 * (0.5 * a[i] + 0.5 * bl[i])); }
  g.putImageData(id, 0, 0);
  return mask;
}
function cloneMask(m) { const c = makeCanvas(m.width, m.height); c.getContext('2d').drawImage(m, 0, 0); return c; }

// method: 'precise' (default; any subject) or 'quick' (people only). Precise falls back to quick only if it fails.
// Returns a validated white+alpha mask canvas (at the input size, max 1600 px) with .method and .stats.
export async function segment(canvas, method = 'precise', progress) {
  const t0 = performance.now();
  lastRun.steps = [];
  const src = scaleToMax(canvas, SEG_MAX);
  let m, used = method;
  try {
    if (method === 'quick') m = await quick(src, progress);
    else {
      try { m = await precise(src, progress); }
      catch (e) {
        note('precise unavailable; refusing people-only fallback for product safety');
        const err = new Error('Precise background removal is unavailable. Your original product photo was kept unchanged. Please retry when the model can load.');
        err.code = 'PRECISE_UNAVAILABLE';
        err.cause = e;
        throw err;
      }
    }
  } finally { if (src !== canvas) freeCanvas(src); }
  const raw = maskStats(m, canvas);
  progress?.('Cleaning up the edges…');
  const keep = cloneMask(m);
  // Product-safe mode: keep the precise model's original alpha matte.
  // Generic component cleanup can erase detached product details or fill real holes.
  // The original image remains untouched; only the background mask is used.
  if (used !== 'precise') refineMask(m);
  let st = maskStats(m, canvas);
  if (raw.ok && (!st.ok || st.coverage < raw.coverage * 0.7)) { note('refinement discarded (would remove too much)'); freeCanvas(m); m = keep; st = raw; } else freeCanvas(keep);
  Object.assign(lastRun, { method: used, model: m.model || (used === 'quick' ? 'mediapipe' : ''), raw, final: st, size: `${m.width}x${m.height}`, ms: Math.round(performance.now() - t0) });
  if (!st.ok) {
    freeCanvas(m);
    const msg = ['empty', 'too faint', 'photo has no visible subject'].includes(st.reason) ? (used === 'quick' ? 'No person found in this photo' : 'No clear subject found in this photo')
      : 'Could not separate a subject from the background';
    const err = new Error(msg); err.code = 'NO_SUBJECT'; throw err;
  }
  m.method = used; m.stats = st;
  return m;
}
