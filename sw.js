// Offline support: app shell is pre-cached; CDN assets (fonts, AI models) are cached the first time they're used.
const VERSION = 'photo-studio-v6';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'vendor/fabric.min.js',
  'js/app.js', 'js/pipeline.js', 'js/store.js', 'js/ai.js', 'js/bgremove.js', 'js/icons.js', 'js/stamps.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const RUNTIME = 'photo-studio-runtime';
const CDN = /(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|storage\.googleapis\.com\/mediapipe|staticimgly\.com)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== RUNTIME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // network-first for the shell so updates arrive, cache fallback offline
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
    return;
  }
  if (CDN.test(url.href)) {
    e.respondWith(caches.open(RUNTIME).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') c.put(req, r.clone()).catch(() => {});
      return r;
    }));
  }
});
