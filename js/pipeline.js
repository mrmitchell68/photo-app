// Image processing pipeline: heal -> adjust/filter -> background composite -> orient/crop.
// All operations are pure canvas/pixel work so they run offline in any modern browser
// (no reliance on ctx.filter, which iOS Safari lacks).

export const PREVIEW_MAX = 1600;
export const FULL_MAX = 4096;

export const DEFAULT_ADJ = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, sharpness: 0 };

export function defaultEdit() {
  return {
    orient: { a: 1, b: 0, c: 0, d: 1 },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    adj: { ...DEFAULT_ADJ },
    filter: 'none',
    filterAmt: 100,
    auto: null,
    heal: [],
    bg: { mode: 'none', maskId: null, color: '#ffffff', c1: '#4facfe', c2: '#00f2fe', angle: 90, blur: 30, imageId: null },
  };
}

export const FILTERS = {
  none: { label: 'Original' },
  vivid: { label: 'Vivid', c: 15, s: 35 },
  warm: { label: 'Warm', w: 30, s: 10 },
  cool: { label: 'Cool', w: -30, s: 5 },
  pop: { label: 'Pop', s: 60, c: 12 },
  bw: { label: 'B&W', gray: 1, c: 10 },
  noir: { label: 'Noir', gray: 1, c: 45, vig: 0.6 },
  sepia: { label: 'Sepia', sepia: 1 },
  fade: { label: 'Fade', fade: 35, c: -15, s: -20 },
  film: { label: 'Film', fade: 15, w: 10, s: -10, c: 5, vig: 0.25 },
  vintage: { label: 'Vintage', sepia: 0.4, fade: 20, vig: 0.4, w: 15 },
  drama: { label: 'Drama', c: 40, s: -10, vig: 0.5 },
};

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }

// Release a temporary canvas's backing store right away (iOS Safari caps total canvas memory).
export function freeCanvas(c) { if (c && typeof HTMLCanvasElement !== 'undefined' && c instanceof HTMLCanvasElement) { c.width = 0; c.height = 0; } }
// Cheap fingerprint (3 pixels) used to detect canvases whose contents were dropped by the browser.
export function canvasSig(c) {
  try { const g = c.getContext('2d', { willReadFrequently: true }); if (!g || !c.width) return 'x';
    const pts = [[0, 0], [c.width >> 1, c.height >> 1], [c.width - 1, c.height - 1]];
    return pts.map(([x, y]) => g.getImageData(x, y, 1, 1).data.join(',')).join('|'); } catch (e) { return 'x'; }
}
export function scaleToMax(src, maxSide) {
  const w = src.width, h = src.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(w * k, h * k);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// ---------- geometry ----------
export function geomDims(w, h, o) { return o.a === 0 ? { w: h, h: w } : { w, h }; }
export function outDims(w, h, edit) {
  const g = geomDims(w, h, edit.orient);
  return { w: Math.max(1, Math.round(g.w * edit.crop.w)), h: Math.max(1, Math.round(g.h * edit.crop.h)), gw: g.w, gh: g.h };
}
export function mulOrient(R, M) {
  // matrices in canvas convention: x' = a x + c y ; y' = b x + d y  => [[a,c],[b,d]]
  return {
    a: R.a * M.a + R.c * M.b,
    c: R.a * M.c + R.c * M.d,
    b: R.b * M.a + R.d * M.b,
    d: R.b * M.c + R.d * M.d,
  };
}
export const ROT_CW = { a: 0, b: 1, c: -1, d: 0 };
export const ROT_CCW = { a: 0, b: -1, c: 1, d: 0 };
export const FLIP_H = { a: -1, b: 0, c: 0, d: 1 };
export const FLIP_V = { a: 1, b: 0, c: 0, d: -1 };

export function applyGeometry(src, edit, ignoreCrop = false) {
  const o = edit.orient;
  const g = geomDims(src.width, src.height, o);
  const cr = ignoreCrop ? { x: 0, y: 0, w: 1, h: 1 } : edit.crop;
  const isIdentity = o.a === 1 && o.d === 1 && cr.x === 0 && cr.y === 0 && cr.w === 1 && cr.h === 1;
  if (isIdentity) return src;
  const out = makeCanvas(g.w * cr.w, g.h * cr.h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(-cr.x * g.w, -cr.y * g.h);
  ctx.translate(g.w / 2, g.h / 2);
  ctx.transform(o.a, o.b, o.c, o.d, 0, 0);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

// ---------- blur (3x box ~ gaussian), RGBA ----------
function boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let ch = 0; ch < 4; ch++) {
      let ti = row + ch, li = ti, ri = ti + r * 4;
      const fv = src[ti], lv = src[row + (w - 1) * 4 + ch];
      let val = (r + 1) * fv;
      for (let j = 0; j < r; j++) val += src[row + Math.min(j, w - 1) * 4 + ch];
      for (let x = 0; x < w; x++) {
        const addIdx = x + r < w ? src[row + (x + r) * 4 + ch] : lv;
        val += addIdx;
        dst[row + x * 4 + ch] = val * iarr;
        const subIdx = x - r >= 0 ? src[row + (x - r) * 4 + ch] : fv;
        val -= subIdx;
      }
    }
  }
}
function boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    for (let ch = 0; ch < 4; ch++) {
      const col = x * 4 + ch;
      const fv = src[col], lv = src[(h - 1) * w * 4 + col];
      let val = (r + 1) * fv;
      for (let j = 0; j < r; j++) val += src[Math.min(j, h - 1) * w * 4 + col];
      for (let y = 0; y < h; y++) {
        val += y + r < h ? src[(y + r) * w * 4 + col] : lv;
        dst[y * w * 4 + col] = val * iarr;
        val -= y - r >= 0 ? src[(y - r) * w * 4 + col] : fv;
      }
    }
  }
}
export function blurData(data, w, h, radius) {
  const r = Math.max(1, Math.round(radius / 2));
  const a = new Float32Array(data);
  const b = new Float32Array(data.length);
  for (let i = 0; i < 3; i++) { boxBlurH(a, b, w, h, r); boxBlurV(b, a, w, h, r); }
  return a;
}
export function blurCanvas(src, radius) {
  // downscale for big radii (fast + same look)
  const k = radius > 16 ? Math.max(0.1, 8 / radius) : 1;
  const small = k < 1 ? scaleToMax(src, Math.max(src.width, src.height) * k) : cloneCanvas(src);
  const g = ctx2d(small);
  const id = g.getImageData(0, 0, small.width, small.height);
  const out = blurData(id.data, small.width, small.height, radius * k);
  id.data.set(out);
  g.putImageData(id, 0, 0);
  if (k === 1) return small;
  const c = makeCanvas(src.width, src.height);
  const cg = c.getContext('2d');
  cg.imageSmoothingQuality = 'high';
  cg.drawImage(small, 0, 0, c.width, c.height);
  return c;
}

// ---------- auto enhance ----------
export function computeAutoLevels(canvas) {
  const s = scaleToMax(canvas, 400);
  const d = ctx2d(s).getImageData(0, 0, s.width, s.height).data;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0, lumSum = 0, satSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; n++;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    lumSum += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114); satSum += mx ? (mx - mn) / mx : 0;
  }
  const pct = (hs, p) => { let acc = 0; const t = n * p; for (let v = 0; v < 256; v++) { acc += hs[v]; if (acc >= t) return v; } return 255; };
  const lv = {};
  ['r', 'g', 'b'].forEach((k, i) => {
    let lo = pct(hist[i], 0.005), hi = pct(hist[i], 0.995);
    if (hi - lo < 40) { lo = Math.max(0, lo - 10); hi = Math.min(255, hi + 10); }
    // don't overcorrect
    lo = Math.min(lo, 60); hi = Math.max(hi, 190);
    lv[k] = [lo, hi];
  });
  const meanL = lumSum / n, meanS = satSum / n;
  return { levels: lv, gamma: meanL < 100 ? 0.85 : meanL > 170 ? 1.1 : 1, sat: meanS < 0.25 ? 18 : 8 };
}

// ---------- adjust ----------
function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
export function adjustCanvas(src, edit) {
  const f = FILTERS[edit.filter] || {};
  const amt = (edit.filterAmt ?? 100) / 100;
  const A = edit.adj;
  const auto = edit.auto;
  const br = A.brightness, co = A.contrast + (f.c || 0) * amt, sa = A.saturation + (f.s || 0) * amt + (auto ? auto.sat : 0);
  const wa = A.warmth + (f.w || 0) * amt, gray = (f.gray || 0) * amt, sepia = (f.sepia || 0) * amt, fade = (f.fade || 0) * amt / 100;
  const vig = (f.vig || 0) * amt, sharp = A.sharpness;
  const noop = !br && !co && !sa && !wa && !gray && !sepia && !fade && !vig && !sharp && !auto;
  if (noop) return src;

  // per-channel LUTs
  const gamma = Math.pow(2, -br / 60) * (auto ? auto.gamma : 1);
  const cf = co >= 0 ? 1 + co / 60 : 1 + co / 110;
  const luts = ['r', 'g', 'b'].map((k, i) => {
    const lut = new Uint8ClampedArray(256);
    const [lo, hi] = auto ? auto.levels[k] : [0, 255];
    const shift = i === 0 ? wa * 0.35 : i === 2 ? -wa * 0.35 : wa * 0.05;
    for (let v = 0; v < 256; v++) {
      let x = (v - lo) / Math.max(1, hi - lo);
      x = Math.min(1, Math.max(0, x));
      x = Math.pow(x, gamma) * 255;
      x = (x - 128) * cf + 128;
      x += shift;
      x = x * (1 - fade * 0.3) + 255 * fade * 0.12;
      lut[v] = clamp(x);
    }
    return lut;
  });
  const out = cloneCanvas(src);
  const g = ctx2d(out);
  const w = out.width, h = out.height;
  const id = g.getImageData(0, 0, w, h);
  const d = id.data;
  const satK = 1 + sa / 100;
  const doSat = satK !== 1 || gray || sepia;
  const cx = w / 2, cy = h / 2, maxR = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < h; y++) {
    const dy = (y - cy) * (y - cy);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = luts[0][d[i]], gg = luts[1][d[i + 1]], b = luts[2][d[i + 2]];
      if (doSat) {
        const L = r * 0.299 + gg * 0.587 + b * 0.114;
        r = L + (r - L) * satK; gg = L + (gg - L) * satK; b = L + (b - L) * satK;
        if (gray) { r += (L - r) * gray; gg += (L - gg) * gray; b += (L - b) * gray; }
        if (sepia) {
          const sr = r * 0.393 + gg * 0.769 + b * 0.189, sg = r * 0.349 + gg * 0.686 + b * 0.168, sb = r * 0.272 + gg * 0.534 + b * 0.131;
          r += (sr - r) * sepia; gg += (sg - gg) * sepia; b += (sb - b) * sepia;
        }
      }
      if (vig) {
        const dist = Math.sqrt((x - cx) * (x - cx) + dy) / maxR;
        const m = 1 - vig * Math.max(0, dist - 0.45) * 1.6;
        r *= m; gg *= m; b *= m;
      }
      d[i] = r; d[i + 1] = gg; d[i + 2] = b;
    }
  }
  if (sharp) {
    const scale = Math.max(w, h) / PREVIEW_MAX;
    if (sharp > 0) {
      const bl = blurData(d, w, h, Math.max(1, 1.5 * scale));
      const k = (sharp / 100) * 1.6;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i] + k * (d[i] - bl[i]); d[i + 1] = d[i + 1] + k * (d[i + 1] - bl[i + 1]); d[i + 2] = d[i + 2] + k * (d[i + 2] - bl[i + 2]);
      }
    } else {
      const bl = blurData(d, w, h, (-sharp / 100) * 14 * scale);
      for (let i = 0; i < d.length; i++) d[i] = bl[i];
    }
  }
  g.putImageData(id, 0, 0);
  return out;
}

// ---------- heal / erase (diffusion inpainting with grain) ----------
export function applyHeal(src, strokes) {
  if (!strokes || !strokes.length) return src;
  const out = cloneCanvas(src);
  const g = ctx2d(out);
  const W = out.width, H = out.height, L = Math.max(W, H);
  for (const s of strokes) healStroke(g, W, H, s.pts.map(([u, v]) => [u * W, v * H]), Math.max(1.5, s.r * L));
  return out;
}
function healStroke(g, W, H, pts, r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const pad = Math.ceil(r * 1.5 + 4);
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(W, Math.ceil(x1 + pad)); y1 = Math.min(H, Math.ceil(y1 + pad));
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return;
  const id = g.getImageData(x0, y0, w, h);
  const d = id.data;
  // full-res soft mask
  const mc = makeCanvas(w, h), mg = ctx2d(mc);
  mg.fillStyle = '#fff'; mg.strokeStyle = '#fff'; mg.lineCap = 'round'; mg.lineJoin = 'round'; mg.lineWidth = r * 2;
  mg.beginPath();
  if (pts.length === 1) { mg.arc(pts[0][0] - x0, pts[0][1] - y0, r, 0, Math.PI * 2); mg.fill(); }
  else { pts.forEach(([x, y], i) => (i ? mg.lineTo(x - x0, y - y0) : mg.moveTo(x - x0, y - y0))); mg.stroke(); }
  const md = mg.getImageData(0, 0, w, h).data;

  // work at reduced scale so big erases stay fast
  const k = Math.min(1, 14 / r);
  const sw = Math.max(2, Math.round(w * k)), sh = Math.max(2, Math.round(h * k));
  const small = makeCanvas(sw, sh), sgc = ctx2d(small);
  const regionC = makeCanvas(w, h); regionC.getContext('2d').putImageData(id, 0, 0);
  sgc.drawImage(regionC, 0, 0, sw, sh);
  const sd = sgc.getImageData(0, 0, sw, sh);
  const smallMask = makeCanvas(sw, sh), smg = ctx2d(smallMask);
  smg.drawImage(mc, 0, 0, sw, sh);
  const smd = smg.getImageData(0, 0, sw, sh).data;
  const n = sw * sh;
  const known = new Uint8Array(n), unknownList = [];
  const f = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    f[i * 3] = sd.data[i * 4]; f[i * 3 + 1] = sd.data[i * 4 + 1]; f[i * 3 + 2] = sd.data[i * 4 + 2];
    if (smd[i * 4 + 3] > 8) unknownList.push(i); else known[i] = 1;
  }
  if (!unknownList.length) return;
  let rem = unknownList, guard = 0;
  while (rem.length && guard++ < 2000) {
    const fill = [], next = [];
    for (const i of rem) {
      const x = i % sw, y = (i / sw) | 0;
      let sr = 0, sg = 0, sb = 0, swt = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= sw || yy >= sh || (!dx && !dy)) continue;
        const j = yy * sw + xx; if (!known[j]) continue;
        const wt = 1 / (dx * dx + dy * dy);
        sr += f[j * 3] * wt; sg += f[j * 3 + 1] * wt; sb += f[j * 3 + 2] * wt; swt += wt;
      }
      if (swt) fill.push(i, sr / swt, sg / swt, sb / swt); else next.push(i);
    }
    if (!fill.length) break;
    for (let q = 0; q < fill.length; q += 4) { const i = fill[q]; f[i * 3] = fill[q + 1]; f[i * 3 + 1] = fill[q + 2]; f[i * 3 + 2] = fill[q + 3]; known[i] = 1; }
    rem = next;
  }
  for (let it = 0; it < 10; it++) for (const i of unknownList) {
    const x = i % sw, y = (i / sw) | 0; if (x < 1 || y < 1 || x >= sw - 1 || y >= sh - 1) continue;
    for (let c = 0; c < 3; c++) f[i * 3 + c] = (f[(i - 1) * 3 + c] + f[(i + 1) * 3 + c] + f[(i - sw) * 3 + c] + f[(i + sw) * 3 + c]) / 4;
  }
  for (let i = 0; i < n; i++) { sd.data[i * 4] = f[i * 3]; sd.data[i * 4 + 1] = f[i * 3 + 1]; sd.data[i * 4 + 2] = f[i * 3 + 2]; }
  sgc.putImageData(sd, 0, 0);
  const up = makeCanvas(w, h), ug = ctx2d(up);
  ug.imageSmoothingQuality = 'high';
  ug.drawImage(small, 0, 0, w, h);
  const ud = ug.getImageData(0, 0, w, h).data;
  // grain estimate from surrounding pixels
  let ns = 0, nn = 0;
  for (let i = 0; i < w * h - 1; i += 3) { if (md[i * 4 + 3] || md[(i + 1) * 4 + 3]) continue; const dv = d[i * 4] - d[(i + 1) * 4]; ns += dv * dv; nn++; }
  const noise = nn ? Math.min(12, Math.sqrt(ns / nn) * 0.45) : 2;
  let seed = 1234567;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = 0; i < w * h; i++) {
    const a = md[i * 4 + 3] / 255; if (a <= 0) continue;
    const nz = rnd() * noise * 2;
    for (let c = 0; c < 3; c++) d[i * 4 + c] = d[i * 4 + c] * (1 - a) + (ud[i * 4 + c] + nz) * a;
  }
  g.putImageData(id, x0, y0);
}

// ---------- background composite ----------
export function drawCover(ctx, img, w, h) {
  const k = Math.max(w / img.width, h / img.height);
  const dw = img.width * k, dh = img.height * k;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
export function paintGradient(ctx, w, h, c1, c2, angle) {
  const rad = (angle - 90) * Math.PI / 180;
  const len = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const cx = w / 2, cy = h / 2, dx = Math.cos(rad) * len / 2, dy = Math.sin(rad) * len / 2;
  const gr = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  gr.addColorStop(0, c1); gr.addColorStop(1, c2);
  ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
}
export function composeBackground(src, bg, mask, assets) {
  if (!bg || bg.mode === 'none' || !mask) return src;
  const w = src.width, h = src.height;
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if (bg.mode === 'color') { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, w, h); }
  else if (bg.mode === 'gradient') paintGradient(ctx, w, h, bg.c1, bg.c2, bg.angle);
  else if (bg.mode === 'blur') ctx.drawImage(blurCanvas(src, (bg.blur || 30) * Math.max(w, h) / PREVIEW_MAX), 0, 0);
  else if (bg.mode === 'image') {
    const a = bg.imageId && assets.get(bg.imageId);
    if (a && a.img) drawCover(ctx, a.img, w, h); else { ctx.fillStyle = '#888'; ctx.fillRect(0, 0, w, h); }
  }
  // subject
  const subj = makeCanvas(w, h);
  const sg = subj.getContext('2d');
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(src, 0, 0);
  sg.globalCompositeOperation = 'destination-in';
  sg.drawImage(mask, 0, 0, w, h);
  // subject is always drawn last, above whatever background was painted
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(subj, 0, 0);
  freeCanvas(subj);
  return out;
}

// full render for a given source (already at desired resolution)
export function render(src, edit, mask, assets, opts = {}) {
  const tmp = [];
  const step = (c, next) => { if (next !== c && c !== src) tmp.push(c); return next; };
  let c = applyHeal(src, edit.heal);
  c = step(c, adjustCanvas(c, edit));
  c = step(c, composeBackground(c, edit.bg, mask, assets));
  c = step(c, applyGeometry(c, edit, opts.ignoreCrop));
  tmp.forEach(t => { if (t !== c) freeCanvas(t); });
  return c;
}

// Turn a float confidence array into a white+alpha mask canvas.
export function maskFromConfidence(conf, mw, mh, w, h, lo = 0.25, hi = 0.75) {
  const m = makeCanvas(mw, mh);
  const g = m.getContext('2d');
  const id = g.createImageData(mw, mh);
  for (let i = 0; i < mw * mh; i++) {
    let a = (conf[i] - lo) / (hi - lo);
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255;
    id.data[i * 4 + 3] = a * 255;
  }
  g.putImageData(id, 0, 0);
  if (mw === w && mh === h) return m;
  const out = makeCanvas(w, h);
  const og = out.getContext('2d');
  og.imageSmoothingQuality = 'high';
  og.drawImage(m, 0, 0, w, h);
  return out;
}
