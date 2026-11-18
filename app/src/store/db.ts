// Tiny IndexedDB key-value store, no dependency.
// Library records are written immediately (rare, user-triggered).
// Settings are kept in memory and flushed in ONE write every 5 min, on hide, and on pagehide (v1 §4.4).

const DB_NAME = 'jharokha';
const STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error);
  }));
}

export const kvGet = <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => tx('readwrite', (s) => s.put(value, key)).then(() => undefined);

// ---- batched settings ---------------------------------------------------------------
export interface Settings {
  currentId: string | null;     // wallpaper shown on Layer 1
  wallScreenLabel: string | null; // which screen gets Layer 1 in dual mode
  showClockOnWall: boolean;
}
const DEFAULTS: Settings = { currentId: null, wallScreenLabel: null, showClockOnWall: true };
const FLUSH_MS = 5 * 60 * 1000;

let settings: Settings = { ...DEFAULTS };
let dirty = false;

export async function loadSettings(): Promise<Settings> {
  settings = { ...DEFAULTS, ...((await kvGet<Settings>('settings')) || {}) };
  return settings;
}

export const getSettings = () => settings;

export function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  dirty = true;
}

export async function flushSettings() {
  if (!dirty) return;
  dirty = false;
  await kvSet('settings', settings);
}

export function startSettingsAutoFlush() {
  setInterval(flushSettings, FLUSH_MS);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSettings(); });
  window.addEventListener('pagehide', () => { flushSettings(); });
}
