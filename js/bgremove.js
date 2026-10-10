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

let imgly;
async function precise(canvas, progress) {
  progress?.('Loading precise model (≈40 MB the first time)…');
  if (!imgly) imgly = await import(IMGLY);
  const blob = await new Promise(r => scaleToMax(canvas, 1600).toBlob(r, 'image/png'));
  const out = await imgly.removeBackground(blob, {
    model: 'isnet_quint8',
    output: { format: 'image/png', type: 'foreground' },
    progress: (key, cur, total) => {
      if (total) progress?.(`Downloading model… ${Math.round((cur / total) * 100)}%`);
    },
  });
  progress?.('Finding the subject…');
  const bmp = await createImageBitmap(out);
  // foreground cut-out: keep its alpha channel as the mask
  const c = makeCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const id = g.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255; }
  g.putImageData(id, 0, 0);
  const full = makeCanvas(canvas.width, canvas.height);
  const fg = full.getContext('2d'); fg.imageSmoothingQuality = 'high';
  fg.drawImage(c, 0, 0, full.width, full.height);
  return full;
}

function coverage(mask) {
  const s = scaleToMax(mask, 128), d = s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
  let a = 0; for (let i = 3; i < d.length; i += 4) a += d[i];
  return a / (255 * (d.length / 4));
}
export async function segment(canvas, method = 'quick', progress) {
  const m = method === 'precise' ? await precise(canvas, progress) : await quick(canvas, progress);
  const cov = coverage(m);
  if (cov < 0.01) throw new Error(method === 'quick' ? 'No person found in this photo. Try “Precise (any subject)”' : 'No clear subject found');
  if (cov > 0.985) throw new Error('Could not separate a subject from the background');
  return m;
}
