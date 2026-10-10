// Optional AI assistant. Bring-your-own-key, OpenAI-compatible chat completions.
// The key is stored ONLY in this device's localStorage and sent ONLY to the base URL the user configures.
const LS = 'photoapp.ai.v1';

export const PROVIDERS = {
  xai: { label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', imageModel: 'grok-imagine-image-2.0' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', imageModel: 'gpt-image-1' },
  custom: { label: 'Other (OpenAI-compatible)', baseUrl: '', model: '', imageModel: '' },
};

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) {}
  const p = PROVIDERS[s.provider] ? s.provider : 'xai';
  return { provider: p, baseUrl: s.baseUrl ?? PROVIDERS[p].baseUrl, model: s.model ?? PROVIDERS[p].model,
    imageModel: s.imageModel ?? PROVIDERS[p].imageModel, apiKey: s.apiKey || '', imageGen: s.imageGen ?? true };
}
export function saveSettings(s) { localStorage.setItem(LS, JSON.stringify(s)); }
export function clearKey() { const s = loadSettings(); s.apiKey = ''; saveSettings(s); }
export function hasKey() { return !!loadSettings().apiKey; }

export const OPS_SPEC = {
  coordinateSystem: 'Positions use normalized image coordinates: x,y in 0..1 measured from the top-left of the final (cropped) photo. You may instead give position as one of: top, bottom, center, top-left, top-right, bottom-left, bottom-right, left, right.',
  operations: [
    { op: 'autoEnhance', desc: 'Automatic levels/color/contrast fix.' },
    { op: 'adjust', params: { brightness: '-100..100', contrast: '-100..100', saturation: '-100..100', warmth: '-100..100 (negative = cooler/bluer)', sharpness: '-100..100 (negative = blur)' }, desc: 'Absolute slider values; omit params you do not want to change.' },
    { op: 'filter', params: { name: 'none|vivid|warm|cool|pop|bw|noir|sepia|fade|film|vintage|drama', amount: '0..100 (default 100)' } },
    { op: 'rotate', params: { direction: 'cw|ccw' } },
    { op: 'flip', params: { axis: 'h|v' } },
    { op: 'crop', params: { aspect: 'original|1:1|4:5|3:4|9:16|16:9|4:3 (centered crop)', or: 'x,y,w,h normalized rect of the current uncropped image' } },
    { op: 'resetCrop' },
    { op: 'removeBackground', params: { method: 'quick (people/selfies, default) | precise (any object, slower)' }, desc: 'Cuts out the subject. Needed before setBackground (it is run automatically if missing).' },
    { op: 'setBackground', params: { type: 'color|gradient|blur|transparent|none|generate', color: 'css color (color type)', color1: 'css color', color2: 'css color', angle: 'degrees for gradient, 90=left-to-right, 180=top-to-bottom', blur: '5..80 (blur type)', prompt: 'text-to-image description for generate type' }, desc: 'Replace the background behind the subject. Use "generate" with a prompt for a realistic scene ONLY when imageGeneration is true; otherwise approximate with a gradient using fitting colors (e.g. beach = sky blue to sand).' },
    { op: 'addText', params: { text: 'string', position: 'named or {x,y}', size: 'font size as fraction of image height, e.g. 0.08', font: 'Bebas Neue|Pacifico|Permanent Marker|Lobster|Playfair Display|Roboto|Impact|Georgia|Courier New', color: 'css color', outline: 'boolean', outlineColor: 'css color', shadow: 'boolean', bold: 'boolean', background: 'css color or null (label box)', angle: 'degrees' } },
    { op: 'addStamp', params: { emoji: 'a single emoji character, e.g. 😎 🌴 ❤️ ⭐', position: 'named or {x,y}', size: 'width as fraction of image width, e.g. 0.2', angle: 'degrees' } },
    { op: 'updateObject', params: { index: 'overlay index from currentOverlays', text: 'optional new text', color: 'optional', position: 'optional', size: 'optional', angle: 'optional' } },
    { op: 'deleteObject', params: { index: 'overlay index' } },
    { op: 'clearOverlays' },
    { op: 'resetAll', desc: 'Undo every edit on this photo.' },
  ],
};

function systemPrompt(ctx) {
  return `You are the edit planner inside a mobile photo editing app. Convert the user's plain-language request into a JSON object:
{"message": "<one short friendly sentence describing what you did>", "commands": [ {"op": "...", ...params} ]}
Return ONLY that JSON. Use only these operations:
${JSON.stringify(OPS_SPEC)}
Rules: commands run in order; the same commands may be applied to several photos, so prefer named positions over overlay indexes; keep text inside the image (use size ~0.06-0.12); put text at the top with position "top" unless told otherwise; prefer bold readable fonts with outline or shadow for legibility; if the request is unclear do the most reasonable thing; if nothing applies return an empty commands array and explain in message.
Current editor state: ${JSON.stringify(ctx)}`;
}

// Robust JSON extraction: strips code fences / <think> blocks and tolerates text around the JSON.
export function extractJSON(text) {
  if (text && typeof text === 'object') return text;
  if (!text || !String(text).trim()) throw new Error('The AI sent an empty reply.');
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(t);
  for (const c of candidates) {
    try { return normalize(JSON.parse(c.trim())); } catch (e) {}
    // scan for balanced {...} or [...] blocks, string-aware
    for (let start = 0; start < c.length; start++) {
      const ch = c[start]; if (ch !== '{' && ch !== '[') continue;
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < c.length; i++) {
        const x = c[i];
        if (inStr) { if (esc) esc = false; else if (x === '\\') esc = true; else if (x === '"') inStr = false; continue; }
        if (x === '"') inStr = true;
        else if (x === '{' || x === '[') depth++;
        else if (x === '}' || x === ']') { depth--; if (depth === 0) { try { return normalize(JSON.parse(c.slice(start, i + 1))); } catch (e) {} break; } }
      }
    }
  }
  throw new Error('The AI reply could not be understood (no valid JSON). Try again or rephrase.');
}
function normalize(j) {
  if (Array.isArray(j)) return { message: '', commands: j };
  if (j && !Array.isArray(j.commands)) j.commands = Array.isArray(j.steps) ? j.steps : Array.isArray(j.actions) ? j.actions : [];
  return j;
}

async function post(url, key, body, signal) {
  const r = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); msg = j.error?.message || j.message || JSON.stringify(j).slice(0, 200); } catch (e) {}
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return r.json();
}

export async function plan(request, ctx, signal) {
  const s = loadSettings();
  if (!s.apiKey) throw new Error('Add your API key in AI settings first.');
  const url = s.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: s.model,
    messages: [{ role: 'system', content: systemPrompt({ ...ctx, imageGeneration: !!(s.imageGen && s.imageModel) }) }, { role: 'user', content: request }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  };
  if (/api\.x\.ai/.test(s.baseUrl)) body.reasoning_effort = 'low';
  let j;
  for (let attempt = 0; ; attempt++) {
    try { j = await post(url, s.apiKey, body, signal); break; }
    catch (e) {
      if (attempt < 2 && e.status === 400 && /reasoning/i.test(e.message) && body.reasoning_effort) { delete body.reasoning_effort; continue; }
      if (attempt < 2 && e.status === 400 && /response_format|json/i.test(e.message) && body.response_format) { delete body.response_format; continue; }
      throw new Error(friendlyError(e));
    }
  }
  const out = extractJSON(j.choices?.[0]?.message?.content);
  if (!Array.isArray(out.commands)) out.commands = [];
  return out;
}

// Text-to-image; returns a Blob. Works with xAI and OpenAI images/generations.
export async function generateImage(prompt, signal) {
  const s = loadSettings();
  if (!s.apiKey || !s.imageModel || !s.imageGen) throw new Error('Image generation is not enabled in AI settings.');
  const url = s.baseUrl.replace(/\/+$/, '') + '/images/generations';
  const body = { model: s.imageModel, prompt, n: 1 };
  if (s.provider !== 'openai') body.response_format = 'b64_json';
  const j = await post(url, s.apiKey, body, signal);
  const d = j.data?.[0];
  if (d?.b64_json) { const bin = atob(d.b64_json); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: 'image/png' }); }
  if (d?.url) { const r = await fetch(d.url); if (!r.ok) throw new Error('Could not download generated image'); return r.blob(); }
  throw new Error('No image returned');
}

// Turn HTTP / network failures into plain words.
export function friendlyError(e) {
  const st = e.status, m = e.message || '';
  if (st === 401 || st === 403 || /incorrect api key|invalid api key|unauthorized/i.test(m))
    return 'Your key was not accepted. Copy the whole API key from console.x.ai (it starts with "xai-"). Note: a SuperGrok subscription does not include API access.';
  if (st === 402 || /credit|billing|quota|insufficient/i.test(m)) return 'Your API account has no credits left. Add credits at console.x.ai, then try again.';
  if (st === 429) return 'Too many requests or out of credits. Wait a minute or check your balance at console.x.ai.';
  if (st === 404 || /model.*(not found|does not exist)/i.test(m)) return 'That model name was not found. Use the default (grok-4.7) or check the model name.';
  if (st >= 500) return 'The AI service is having trouble right now (' + st + '). Try again in a bit.';
  if (!st) return 'Could not reach the AI service. Check your internet connection and the Base URL.';
  return 'The AI service said: ' + m;
}
// Tiny request to check the key. Returns a plain-words result.
export async function testKey(draft) {
  const s = draft || loadSettings();
  if (!s.apiKey) return { ok: false, message: 'Paste your API key first.' };
  const url = (s.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const body = { model: s.model, messages: [{ role: 'user', content: 'Reply with exactly: {"ok":true}' }], response_format: { type: 'json_object' } };
  if (/api\.x\.ai/.test(s.baseUrl)) body.reasoning_effort = 'low';
  try {
    let j;
    try { j = await post(url, s.apiKey, body); }
    catch (e) { if (e.status === 400 && /reasoning|response_format/i.test(e.message)) { delete body.reasoning_effort; delete body.response_format; j = await post(url, s.apiKey, body); } else throw e; }
    return { ok: true, message: `It works! Your key is valid and ${s.model} replied.` };
  } catch (e) { return { ok: false, message: friendlyError(e) }; }
}
export async function testConnection() { const r = await testKey(); if (!r.ok) throw new Error(r.message); return r; }

// Web Speech API dictation (Chrome/Android, Safari iOS 14.5+). Returns stop() or null if unsupported.
export function dictate(onText, onEnd) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true; rec.continuous = false;
  rec.onresult = (e) => { let t = ''; for (const r of e.results) t += r[0].transcript; onText(t, e.results[e.results.length - 1].isFinal); };
  rec.onend = () => onEnd?.(); rec.onerror = (e) => onEnd?.(e.error);
  rec.start();
  return () => rec.stop();
}
export const speechSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
