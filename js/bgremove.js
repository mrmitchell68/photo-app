// On-device background removal. Two engines, both loaded lazily from public CDNs
// (then cached by the service worker for offline use):
//  - 'quick'   : MediaPipe selfie multiclass segmenter (~16 MB model). Fast; people/selfies only.
//  - 'precise' : IMG.LY background-removal (ISNet, ~40 MB first download). Any subject, better edges, slower.
import { maskFromConfidence, scaleToMax, makeCanvas } from './pipeline.js';

const MP_VER = '1.1.0';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const IMGLY = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';

let mpSeg;
async function getMediaPipe(progress) {
  if (mpSeg) return mpSeg;
  progress?.('Loading on-device AI model…');
  const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const make = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MP_MODEL, delegate },
    runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  });
  try { mpSeg = await make('GPU'); } catch (e) { mpSeg = await make('CPU'); }
  return mpSeg;
}

async function quick(canvas, progress) {
  const seg = await getMediaPipe(progress);
  progress?.('Finding the subject…');
  const input = scaleToMax(canvas, 1024);
  const res = seg.segment(input);
  const masks = res.confidenceMasks;
  const m0 = masks[0];
  const w = m0.width, h = m0.height;
  let conf;
  if (masks.length > 1) {
    const bg = m0.getAsFloat32Array();
    conf = new Float32Array(bg.length);
    for (let i = 0; i < bg.length; i++) conf[i] = 1 - bg[i];
  } else conf = Float32Array.from(m0.getAsFloat32Array());
  masks.forEach(m => m.close && m.close());
  return maskFromConfidence(conf, w, h, canvas.width, canvas.height, 0.3, 0.7);
}

// Precise engine: IMG.LY ISNet. fp16 weights (~80 MB, one-time download, then cached by the service worker)
// gave clearly cleaner cut-outs than the 8-bit build in our tests (no snow/halo haze, solid interiors);
// the 8-bit build (~40 MB) is the fallback if fp16 can't load/run on a device.
let imgly; const PRECISE_MODELS = ['isnet_fp16', 'isnet_quint8'];
const READY_KEY = 'photoapp.bgModelReady';
async function precise(canvas, progress) {
  const cached = (() => { try { return localStorage.getItem(READY_KEY); } catch (e) { return null; } })();
  progress?.(cached ? 'Removing background…' : 'Getting the background model ready (one-time download, about 80 MB)…');
  if (!imgly) imgly = await import(IMGLY);
  const blob = await new Promise(r => scaleToMax(canvas, 1600).toBlob(r, 'image/png'));
  let out, lastErr;
  for (const model of (cached === 'isnet_quint8' ? ['isnet_quint8'] : PRECISE_MODELS)) {
    try {
      out = await imgly.removeBackground(blob, {
        model, device: 'cpu',
        output: { format: 'image/png', type: 'foreground' },
        progress: (key, cur, total) => {
          if (!total || !/fetch/.test(key)) return;
          const pct = Math.round((cur / total) * 100);
          progress?.(pct < 100 ? `Downloading background model (one-time, ${model === 'isnet_fp16' ? '≈80' : '≈40'} MB)… ${pct}%` : 'Removing background…');
        },
      });
      try { localStorage.setItem(READY_KEY, model); } catch (e) {}
      break;
    } catch (e) { lastErr = e; console.warn('precise model failed', model, e); }
  }
  if (!out) throw lastErr || new Error('precise model failed');
  progress?.('Cleaning up the edges…');
  const bmp = await createImageBitmap(out);
  const c = makeCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const id = g.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255; }
  g.putImageData(id, 0, 0);
  return c;
}

// Edge refinement on a white+alpha mask (in place). Removes stray specks, fills pinholes inside the subject,
// firms up the matte (faint haze -> clear, near-solid -> solid) and adds a light, non-eroding feather.
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
    const fg = a[s] >= 0.5; let sp = 0, size = 0, border = false; const L = comps.length;
    stack[sp++] = s; lab[s] = L;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && lab[i - 1] === -1 && (a[i - 1] >= 0.5) === fg) { lab[i - 1] = L; stack[sp++] = i - 1; }
      if (x < w - 1 && lab[i + 1] === -1 && (a[i + 1] >= 0.5) === fg) { lab[i + 1] = L; stack[sp++] = i + 1; }
      if (y > 0 && lab[i - w] === -1 && (a[i - w] >= 0.5) === fg) { lab[i - w] = L; stack[sp++] = i - w; }
      if (y < h - 1 && lab[i + w] === -1 && (a[i + w] >= 0.5) === fg) { lab[i + w] = L; stack[sp++] = i + w; }
    }
    comps.push({ fg, size, border });
  }
  let big = 0; for (const c of comps) if (c.fg && c.size > big) big = c.size;
  const action = comps.map(c => c.fg ? (c.size < Math.min(0.01 * big, 0.002 * n) ? 'drop' : '') : (!c.border && c.size < 0.0015 * n ? 'fill' : ''));
  const ss = (t) => { t = (t - 0.08) / 0.84; t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
  for (let i = 0; i < n; i++) { const ac = action[lab[i]]; a[i] = ac === 'drop' ? 0 : ac === 'fill' ? 1 : ss(a[i]); }
  // light feather: average with a small box blur (keeps the 50% edge in place, so no erosion)
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
function toSize(m, w, h) {
  if (m.width === w && m.height === h) return m;
  const full = makeCanvas(w, h), fg = full.getContext('2d'); fg.imageSmoothingQuality = 'high';
  fg.drawImage(m, 0, 0, w, h); return full;
}

function coverage(mask) {
  const s = scaleToMax(mask, 128), d = s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
  let a = 0; for (let i = 3; i < d.length; i += 4) a += d[i];
  return a / (255 * (d.length / 4));
}
const NO_SUBJECT = 'No clear subject found in this photo';
// method: 'precise' (default; any subject) or 'quick' (people only). Precise falls back to quick only if it fails to run.
export async function segment(canvas, method = 'precise', progress) {
  let m, used = method;
  if (method === 'quick') m = await quick(canvas, progress);
  else {
    try { m = await precise(canvas, progress); }
    catch (e) { console.warn('precise failed, using quick', e); used = 'quick'; progress?.('Precise model unavailable, using the quick people model…'); m = await quick(scaleToMax(canvas, 1600), progress); }
  }
  m = toSize(refineMask(m), canvas.width, canvas.height);
  const cov = coverage(m);
  if (cov < 0.01) throw new Error(used === 'quick' ? 'No person found in this photo' : NO_SUBJECT);
  if (cov > 0.985) throw new Error('Could not separate a subject from the background');
  m.method = used;
  return m;
}
