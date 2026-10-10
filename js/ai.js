// Optional AI assistant. Bring-your-own-key, OpenAI-compatible chat completions.
// The key is stored ONLY in this device's localStorage and sent ONLY to the base URL the user configures.
const LS = 'photoapp.ai.v1';

// Presets. "free" providers have a no-card free tier and allow browser (CORS) calls; verified Oct 2026.
export const PROVIDERS = {
  gemini: { label: 'Google Gemini', badge: 'Free', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', imageModel: '',
    keyUrl: 'https://aistudio.google.com/apikey', keyHost: 'aistudio.google.com', keyHint: 'AIza…', reasoning: true,
    note: 'Free, no credit card: sign in with your Google account at aistudio.google.com/apikey and tap “Create API key”. Free-tier limits are per project and shown in AI Studio; daily quota resets at midnight Pacific. On the free tier Google may use your prompts to improve its products. No AI-generated backgrounds (gradients are used instead).' },
  groq: { label: 'Groq', badge: 'Free', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', imageModel: '',
    keyUrl: 'https://console.groq.com/keys', keyHost: 'console.groq.com', keyHint: 'gsk_…', reasoning: true,
    note: 'Free, no credit card: sign up at console.groq.com/keys and tap “Create API Key”. Free plan for this model: 30 requests/minute and 1,000 requests/day. No AI-generated backgrounds (gradients are used instead).' },
  xai: { label: 'xAI (Grok)', badge: 'Paid', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', imageModel: 'grok-imagine-image-2.0',
    keyUrl: 'https://console.x.ai', keyHost: 'console.x.ai', keyHint: 'xai-…', reasoning: true,
    note: 'Pay per use: get an API key at console.x.ai and add credits. A SuperGrok subscription does not include API access. About $7 per 1,000 AI requests with grok-4.7 (grok-4.3 is about half; change it under Advanced). AI backgrounds 4¢ each.' },
  openai: { label: 'OpenAI', badge: 'Paid', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', imageModel: 'gpt-image-1-mini',
    keyUrl: 'https://platform.openai.com/api-keys', keyHost: 'platform.openai.com', keyHint: 'sk-…', reasoning: true,
    note: 'Pay per use: get an API key at platform.openai.com/api-keys and add credit. About $0.45 per 1,000 AI requests with gpt-6-luna. AI backgrounds about 1–2¢ each (gpt-image-1-mini, medium quality).' },
  deepseek: { label: 'DeepSeek', badge: 'Paid', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', imageModel: '',
    keyUrl: 'https://platform.deepseek.com/api_keys', keyHost: 'platform.deepseek.com', keyHint: 'sk-…', reasoning: false,
    note: 'Very cheap pay per use: top up at platform.deepseek.com and create an API key. About $0.60–$1.20 per 1,000 AI requests. No AI-generated backgrounds (gradients are used instead).' },
  anthropic: { label: 'Claude (Anthropic)', badge: 'Paid', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', imageModel: '',
    keyUrl: 'https://console.anthropic.com/settings/keys', keyHost: 'console.anthropic.com', keyHint: 'sk-ant-…', reasoning: false,
    note: 'Pay per use: add credit and create a key at console.anthropic.com. About $0.45 per 1,000 AI requests with Claude Haiku 5.5. No AI-generated backgrounds (gradients are used instead).' },
  custom: { label: 'Other', badge: '', baseUrl: '', model: '', imageModel: '', keyUrl: '', keyHost: '', keyHint: '', reasoning: false,
    note: 'Any OpenAI-compatible service that allows browser requests: set its Base URL and model under Advanced.' },
};
export const DEFAULT_PROVIDER = 'gemini';

// Storage: { provider, profiles: { [id]: {apiKey, baseUrl, model, imageModel, imageGen} } } plus a flat mirror of
// the active profile (the v1 format). Old flat-only settings are read as the profile of their saved provider,
// so an existing xAI key keeps working until the user switches.
function readRaw() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } }
function profileOf(raw, id) {
  const d = PROVIDERS[id] || PROVIDERS.custom;
  let pr = raw.profiles?.[id];
  if (!pr && !raw.profiles && raw.provider === id) pr = { apiKey: raw.apiKey, baseUrl: raw.baseUrl, model: raw.model, imageModel: raw.imageModel, imageGen: raw.imageGen };
  pr = pr || {};
  return { apiKey: pr.apiKey || '', baseUrl: pr.baseUrl || d.baseUrl, model: pr.model || d.model, imageModel: pr.imageModel ?? d.imageModel, imageGen: pr.imageGen ?? !!d.imageModel };
}
export function loadSettings(id) {
  const raw = readRaw();
  const provider = PROVIDERS[raw.provider] ? raw.provider : DEFAULT_PROVIDER;
  const pid = id && PROVIDERS[id] ? id : provider;
  return { provider: pid, active: provider, ...profileOf(raw, pid) };
}
// Save a provider profile. Only makes it the active provider when makeActive is true (the Save button).
export function saveSettings(draft, makeActive = true) {
  const raw = readRaw();
  const profiles = raw.profiles || {};
  if (!raw.profiles && raw.provider && PROVIDERS[raw.provider]) profiles[raw.provider] = profileOf(raw, raw.provider); // migrate v1 flat format
  const { provider, apiKey, baseUrl, model, imageModel, imageGen } = draft;
  profiles[provider] = { apiKey, baseUrl, model, imageModel, imageGen };
  const active = makeActive ? provider : (PROVIDERS[raw.provider] ? raw.provider : DEFAULT_PROVIDER);
  const flat = active === provider ? profiles[provider] : profileOf({ profiles }, active);
  localStorage.setItem(LS, JSON.stringify({ provider: active, profiles, ...flat }));
}
export function clearKey(id) { const s = loadSettings(id); s.apiKey = ''; saveSettings(s, false); }
export function hasKey() { return !!loadSettings().apiKey; }
export function providerInfo(id) { return PROVIDERS[id] || PROVIDERS.custom; }
export function imageGenAvailable(s = loadSettings()) { return !!(s.apiKey && s.imageGen && s.imageModel); }

export const OPS_SPEC = {
  format: 'Each command is a flat object: the "op" name plus its parameters at the same level. Do NOT wrap parameters in "params".',
  coordinateSystem: 'Positions use normalized image coordinates: x,y in 0..1 measured from the top-left of the final (cropped) photo. You may instead give position as one of: top, bottom, center, top-left, top-right, bottom-left, bottom-right, left, right.',
  operations: [
    { op: 'autoEnhance', desc: 'Automatic levels/color/contrast fix.' },
    { op: 'adjust', brightness: '-100..100', contrast: '-100..100', saturation: '-100..100', warmth: '-100..100 (negative = cooler/bluer)', sharpness: '-100..100 (negative = blur)', desc: 'Absolute slider values; omit the ones you do not want to change.' },
    { op: 'filter', name: 'none|vivid|warm|cool|pop|bw|noir|sepia|fade|film|vintage|drama', amount: '0..100 (default 100)' },
    { op: 'rotate', direction: 'cw|ccw' },
    { op: 'flip', axis: 'h|v' },
    { op: 'crop', aspect: 'original|1:1|4:5|3:4|9:16|16:9|4:3 (centered crop)' },
    { op: 'resetCrop' },
    { op: 'setBackground', type: 'color|gradient|blur|transparent|none|generate', color: 'css color (type color)', color1: 'css color (gradient top/start)', color2: 'css color (gradient bottom/end)', angle: 'gradient degrees, 180 = top-to-bottom', blur: '5..80 (type blur)', prompt: 'scene description (type generate)',
      desc: 'Replaces everything behind the main subject in ONE step (the app cuts out the subject automatically and keeps it on top; the photo itself is never removed). Use exactly one setBackground per request. "transparent" only when the user asks for a cut-out/transparent/PNG; "none" restores the original background. Use "generate" ONLY when imageGeneration is true; otherwise approximate the scene with a fitting gradient (e.g. beach = sky blue #87CEEB to sand #F4D9A6).' },
    { op: 'addText', text: 'string', position: 'named or {x,y}', size: 'font size as fraction of image height, e.g. 0.08', font: 'Bebas Neue|Pacifico|Permanent Marker|Lobster|Playfair Display|Roboto|Impact|Georgia|Courier New', color: 'css color', outline: 'boolean', outlineColor: 'css color', shadow: 'boolean', bold: 'boolean', background: 'css color or null (label box)', angle: 'degrees' },
    { op: 'addStamp', emoji: 'a single emoji character, e.g. 😎 🌴 ❤️ ⭐', position: 'named or {x,y}', size: 'width as fraction of image width, e.g. 0.2', angle: 'degrees' },
    { op: 'updateObject', index: 'overlay index from currentOverlays', text: 'optional new text', color: 'optional', position: 'optional', size: 'optional', angle: 'optional' },
    { op: 'deleteObject', index: 'overlay index (only when the user asks to remove that text/stamp)' },
    { op: 'clearOverlays', desc: 'Only when the user asks to remove all text/stamps.' },
    { op: 'resetAll', desc: 'Only when the user explicitly asks to start over / undo everything.' },
  ],
  examples: [
    { request: 'change the background to a beach', reply: { message: 'Put a sunny beach behind the subject.', commands: [{ op: 'setBackground', type: 'gradient', color1: '#87CEEB', color2: '#F4D9A6', angle: 180 }] } },
    { request: 'make it black and white and add Hello at the top', reply: { message: 'Black and white with a title.', commands: [{ op: 'filter', name: 'bw' }, { op: 'addText', text: 'Hello', position: 'top', size: 0.09, font: 'Bebas Neue', color: '#ffffff', outline: true }] } },
  ],
};

function systemPrompt(ctx) {
  return `You are the edit planner inside a mobile photo editing app. Convert the user's plain-language request into a JSON object:
{"message": "<one short friendly sentence describing what you did>", "commands": [ {"op": "...", ...parameters} ]}
Return ONLY that JSON. Use only these operations (parameters go directly on each command object):
${JSON.stringify(OPS_SPEC)}
Rules: commands run in order; the same commands may be applied to several photos, so prefer named positions over overlay indexes; keep text inside the image (use size ~0.06-0.12); put text at the top with position "top" unless told otherwise; prefer bold readable fonts with outline or shadow for legibility; never remove or replace the photo itself; if the request is unclear do the most reasonable thing; if nothing applies return an empty commands array and explain in message.
Current editor state: ${JSON.stringify(ctx)}`;
}

// ---- Command sanitizer: accepts the many shapes different models produce and outputs the strict schema. ----
const OP_ALIASES = {
  autoenhance: 'autoEnhance', enhance: 'autoEnhance', autoenhancephoto: 'autoEnhance',
  adjust: 'adjust', adjustment: 'adjust', adjustments: 'adjust',
  filter: 'filter', applyfilter: 'filter', setfilter: 'filter',
  rotate: 'rotate', flip: 'flip', crop: 'crop', resetcrop: 'resetCrop',
  removebackground: 'removeBackground', removebg: 'removeBackground', cutout: 'removeBackground', deletebackground: 'removeBackground', segment: 'removeBackground',
  setbackground: 'setBackground', replacebackground: 'setBackground', changebackground: 'setBackground', background: 'setBackground', newbackground: 'setBackground', addbackground: 'setBackground', generatebackground: 'setBackground', backgroundreplace: 'setBackground', swapbackground: 'setBackground',
  addtext: 'addText', text: 'addText', addcaption: 'addText', caption: 'addText', addstamp: 'addStamp', stamp: 'addStamp', addemoji: 'addStamp', emoji: 'addStamp', addsticker: 'addStamp', sticker: 'addStamp',
  updateobject: 'updateObject', deleteobject: 'deleteObject', removeobject: 'deleteObject', clearoverlays: 'clearOverlays', resetall: 'resetAll', reset: 'resetAll',
};
const BG_TYPES = { color: 'color', solid: 'color', colour: 'color', gradient: 'gradient', lineargradient: 'gradient', blur: 'blur', blurred: 'blur', bokeh: 'blur', transparent: 'transparent', cutout: 'transparent', remove: 'transparent', removed: 'transparent', none: 'none', original: 'none', restore: 'none',
  generate: 'generate', generated: 'generate', image: 'generate', photo: 'generate', scene: 'generate', ai: 'generate', prompt: 'generate', picture: 'generate' };
const SCENES = [[/sunset|sunrise|golden/i, '#ff7e5f', '#feb47b'], [/beach|tropical|sand|ocean|sea|island/i, '#87CEEB', '#F4D9A6'], [/night|stars|space|galaxy/i, '#0f2027', '#2c5364'],
  [/forest|jungle|park|garden|grass|nature/i, '#a8e063', '#2f7336'], [/snow|winter|ice/i, '#e6f0ff', '#b8d4f0'], [/sky|cloud/i, '#5ea9ff', '#d6ecff'], [/city|urban|street/i, '#757f9a', '#d7dde8'],
  [/studio|grey|gray|neutral|plain/i, '#e9e9ee', '#9a9aa5'], [/mountain/i, '#8ec5fc', '#e0c3fc']];
const isColor = (v) => typeof v === 'string' && v.trim().length > 0 && v.length < 40;
function sceneGradient(text) { for (const [re, c1, c2] of SCENES) if (re.test(text || '')) return [c1, c2]; return ['#6ec6ff', '#f5d9a6']; }
function flatten(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  let o = { ...c };
  for (const k of ['params', 'parameters', 'args', 'arguments', 'options', 'settings', 'data', 'input']) {
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) { o = { ...o[k], ...o }; delete o[k]; }
  }
  const name = o.op ?? o.operation ?? o.action ?? o.command ?? o.type_op ?? o.tool ?? o.name_op;
  // {"setBackground": {...}} single-key form
  if (!name) { const keys = Object.keys(o); if (keys.length === 1 && typeof o[keys[0]] === 'object') return flatten({ op: keys[0], ...o[keys[0]] }); }
  o.op = name; delete o.operation; delete o.action; delete o.command; delete o.tool;
  return o;
}
function normBackground(o, request) {
  let t = String(o.type ?? o.mode ?? o.kind ?? o.style ?? o.backgroundType ?? '').toLowerCase().replace(/[^a-z]/g, '');
  let prompt = o.prompt ?? o.description ?? o.scene ?? (typeof o.background === 'string' ? o.background : null) ?? (typeof o.image === 'string' ? o.image : null) ?? o.value;
  if (typeof prompt === 'string') prompt = prompt.replace(/^\s*(image\s*prompt|prompt|image)\s*[:=-]\s*/i, '').trim(); else prompt = null;
  const colors = Array.isArray(o.colors) ? o.colors.filter(isColor) : null;
  let type = BG_TYPES[t] || null;
  if (!type) type = colors?.length > 1 || o.color1 ? 'gradient' : isColor(o.color) ? 'color' : prompt ? 'generate' : o.blur != null ? 'blur' : (o.op === 'removeBackground' ? 'transparent' : null);
  if (!type) type = 'generate'; // "change the background" with no details -> scene from the request text
  const out = { op: 'setBackground', type };
  if (type === 'color') out.color = isColor(o.color) ? o.color : colors?.[0] || '#ffffff';
  if (type === 'gradient') { out.color1 = isColor(o.color1) ? o.color1 : colors?.[0] || (isColor(o.color) ? o.color : sceneGradient(prompt || request)[0]); out.color2 = isColor(o.color2) ? o.color2 : colors?.[1] || sceneGradient(prompt || request)[1]; out.angle = Number.isFinite(+o.angle) ? +o.angle : 180; }
  if (type === 'blur') out.blur = Math.max(5, Math.min(80, +o.blur || +o.amount || 30));
  if (type === 'generate') { out.prompt = (prompt || request || 'beautiful scenic background').slice(0, 400); [out.color1, out.color2] = sceneGradient(out.prompt + ' ' + (request || '')); }
  return out;
}
// Returns { commands, warnings }. Never emits anything that could drop the photo; background steps are merged into one.
export function sanitizeCommands(cmds, request = '') {
  const warnings = [], out = [];
  const wantsReset = /\b(reset|start over|undo (all|every)|original|from scratch|remove all edits)\b/i.test(request);
  const wantsClear = /\b(remove|delete|clear|get rid of)\b.*\b(text|words|caption|stamp|sticker|emoji|overlay)s?\b|\bclear\b/i.test(request);
  const wantsCutout = /\b(transparent|cut ?out|png|no background|without (a |the )?background|remove (the )?background|isolate)\b/i.test(request);
  let bg = null, bgIndex = -1;
  for (const raw of (Array.isArray(cmds) ? cmds : []).slice(0, 30)) {
    const o = flatten(raw); if (!o || o.op == null) { warnings.push('ignored a malformed step'); continue; }
    const key = String(o.op).toLowerCase().replace(/[^a-z]/g, '');
    const op = OP_ALIASES[key];
    if (!op) { warnings.push(`ignored unknown step “${String(o.op).slice(0, 30)}”`); continue; }
    if (op === 'removeBackground' || op === 'setBackground') {
      const spec = normBackground({ ...o, op }, request);
      // later setBackground wins; a bare removeBackground never overrides a real background choice
      if (op === 'removeBackground' && bg && bg.type !== 'transparent') continue;
      if (bg && spec.type === 'transparent' && bg.type !== 'transparent' && op === 'setBackground' && !wantsCutout) continue;
      if (!bg || !(op === 'removeBackground' && bg)) { bg = spec; if (bgIndex < 0) bgIndex = out.length; }
      continue;
    }
    if (op === 'resetAll' && !wantsReset) { warnings.push('ignored “reset everything” (not requested)'); continue; }
    if ((op === 'clearOverlays' || op === 'deleteObject') && !wantsClear) { warnings.push('ignored removing text/stamps (not requested)'); continue; }
    const c = { ...o, op };
    if (op === 'filter') c.name = String(c.name ?? c.filter ?? c.value ?? 'none').toLowerCase();
    if (op === 'addText') c.text = String(c.text ?? c.content ?? c.value ?? '').slice(0, 200);
    if (op === 'addStamp') c.emoji = String(c.emoji ?? c.stamp ?? c.value ?? '');
    out.push(c);
  }
  if (bg) {
    // asked to change/replace the background but the model only "removed" it -> give it a fitting scene instead of nothing
    if (bg.type === 'transparent' && !wantsCutout && /\b(change|replace|swap|new|put|make|set|add)\b.*\bbackground\b|\bbackground\b.*\b(to|with|into|of)\b|\bbehind\b/i.test(request)) {
      const [c1, c2] = sceneGradient(request); bg = { op: 'setBackground', type: 'gradient', color1: c1, color2: c2, angle: 180 }; warnings.push('used a fitting gradient for the new background');
    }
    out.splice(Math.max(0, bgIndex), 0, bg);
  }
  return { commands: out, warnings };
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

// Provider quirks keyed by URL so they also apply when set up via "Other".
function extras(baseUrl) {
  if (/api\.anthropic\.com/.test(baseUrl)) return { headers: { 'anthropic-dangerous-direct-browser-access': 'true' }, body: { max_tokens: 2048 } };
  if (/api\.deepseek\.com/.test(baseUrl)) return { headers: {}, body: { thinking: { type: 'disabled' }, max_tokens: 2048 } };
  return { headers: {}, body: {} };
}
async function post(url, key, body, signal) {
  const x = extras(url);
  const r = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...x.headers }, body: JSON.stringify({ ...x.body, ...body }) });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { let j = await r.json(); if (Array.isArray(j)) j = j[0] || {}; msg = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || j.detail || JSON.stringify(j).slice(0, 200); } catch (e) {}
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
    messages: [{ role: 'system', content: systemPrompt({ ...ctx, imageGeneration: imageGenAvailable(s) }) }, { role: 'user', content: request }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  };
  if (providerInfo(s.provider).reasoning) body.reasoning_effort = 'low';
  let j;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { j = await post(url, s.apiKey, body, signal); break; }
    catch (e) {
      if (attempt < 2 && e.status === 400 && /reasoning/i.test(e.message) && body.reasoning_effort) { delete body.reasoning_effort; continue; }
      if (attempt < 3 && e.status === 400 && /temperature/i.test(e.message) && 'temperature' in body) { delete body.temperature; continue; }
      if (attempt < 2 && e.status === 400 && /response_format|json/i.test(e.message) && body.response_format) { delete body.response_format; continue; }
      throw new Error(friendlyError(e, s));
    }
  }
  const out = extractJSON(j.choices?.[0]?.message?.content);
  const rawCommands = Array.isArray(out.commands) ? out.commands : [];
  const { commands, warnings } = sanitizeCommands(rawCommands, request);
  return { message: typeof out.message === 'string' ? out.message.slice(0, 300) : '', commands, warnings, rawCommands, provider: s.provider, model: s.model };
}

// Text-to-image; returns a Blob. Works with xAI and OpenAI images/generations.
export async function generateImage(prompt, signal) {
  const s = loadSettings();
  if (!imageGenAvailable(s)) throw new Error(providerInfo(s.provider).badge === 'Free' ? 'the free provider does not generate images' : 'image generation is off in AI settings');
  const url = s.baseUrl.replace(/\/+$/, '') + '/images/generations';
  const body = { model: s.imageModel, prompt, n: 1 };
  if (/api\.openai\.com/.test(s.baseUrl)) body.quality = 'medium'; else body.response_format = 'b64_json';
  const j = await post(url, s.apiKey, body, signal);
  const d = j.data?.[0];
  if (d?.b64_json) { const bin = atob(d.b64_json); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: 'image/png' }); }
  if (d?.url) { const r = await fetch(d.url); if (!r.ok) throw new Error('Could not download generated image'); return r.blob(); }
  throw new Error('No image returned');
}

// Turn HTTP / network failures into plain words.
export function friendlyError(e, s = loadSettings()) {
  const st = e.status, m = e.message || '', P = providerInfo(s.provider);
  const where = P.keyHost || 'your provider';
  if (st === 401 || st === 403 || /api[ _-]?key|unauthori[sz]ed|permission/i.test(m))
    return `Your key was not accepted. Copy the whole API key from ${where}${P.keyHint ? ` (it starts with "${P.keyHint.replace('…', '')}")` : ''}.` + (s.provider === 'xai' ? ' Note: a SuperGrok subscription does not include API access.' : '');
  if (st === 429 || /quota|rate.?limit|resource_exhausted|too many/i.test(m))
    return P.badge === 'Free' ? `You've reached the free-tier limit for now. Wait a minute and try again; daily limits reset each day. You can also switch to the other free provider in AI settings.` : 'Too many requests or out of credits. Wait a minute or check your balance at ' + where + '.';
  if (st === 402 || /credit|billing|insufficient|payment/i.test(m)) return `Your account has no credits left. Add credits at ${where}, or switch to a free provider in AI settings.`;
  if (st === 404 || /model.*(not found|does not exist|not supported)/i.test(m)) return `The model "${s.model}" was not found. Tap the provider again to restore its default model.`;
  if (/location|region|country|not available in your/i.test(m)) return 'This provider is not available in your region. Try the other free provider.';
  if (st >= 500) return 'The AI service is having trouble right now (' + st + '). Try again in a bit.';
  if (!st && /api\.openai\.com/.test(s.baseUrl || '')) return 'OpenAI did not answer. Usually this means the key was not accepted (OpenAI hides the reason from browsers) or there is no internet. Check the key at platform.openai.com/api-keys.';
  if (!st) return 'Could not reach the AI service. Check your internet connection and the Base URL.';
  return 'The AI service said: ' + m;
}
// Tiny request to check the key. Returns a plain-words result.
export async function testKey(draft) {
  const s = draft || loadSettings();
  if (!s.apiKey) return { ok: false, message: 'Paste your API key first.' };
  const url = (s.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const body = { model: s.model, messages: [{ role: 'user', content: 'Reply with exactly this JSON: {"ok":true}' }], response_format: { type: 'json_object' } };
  if (providerInfo(s.provider).reasoning) body.reasoning_effort = 'low';
  try {
    try { await post(url, s.apiKey, body); }
    catch (e) { if (e.status === 400 && /reasoning|response_format|json/i.test(e.message) && !/api[ _-]?key/i.test(e.message)) { delete body.reasoning_effort; delete body.response_format; await post(url, s.apiKey, body); } else throw e; }
    return { ok: true, message: `It works! Your key is valid and ${s.model} replied.` };
  } catch (e) { return { ok: false, message: friendlyError(e, s) }; }
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
