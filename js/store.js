// Tiny IndexedDB wrapper so the session survives reloads / the app being closed.
const DB_NAME = 'photo-app', VER = 1;
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
// Some WebKit builds refuse to store Blobs in IndexedDB; fall back to ArrayBuffers (revived on read).
async function deblob(v) {
  const o = { ...v };
  for (const k of Object.keys(o)) if (o[k] instanceof Blob) o[k] = { __blob: 1, type: o[k].type, buf: await o[k].arrayBuffer() };
  return o;
}
function reblob(v) {
  if (!v || typeof v !== 'object') return v;
  for (const k of Object.keys(v)) if (v[k] && v[k].__blob === 1 && v[k].buf) v[k] = new Blob([v[k].buf], { type: v[k].type });
  return v;
}
export const put = (store, v) => tx(store, 'readwrite', s => s.put(v))
  .catch(async (e) => {
    if (!v || !Object.values(v).some(x => x instanceof Blob)) throw e;
    const o = await deblob(v);
    return tx(store, 'readwrite', s => s.put(o));
  })
  .catch(e => console.warn('idb put', e));
export const del = (store, k) => tx(store, 'readwrite', s => s.delete(k)).catch(e => console.warn('idb del', e));
export const all = (store) => tx(store, 'readonly', s => s.getAll()).then(l => (l || []).map(reblob)).catch(() => []);
export const get = (store, k) => tx(store, 'readonly', s => s.get(k)).then(reblob).catch(() => undefined);
