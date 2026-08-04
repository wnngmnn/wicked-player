// ── Durable app storage ────────────────────────────────────────────────────
// All library metadata + cover art lives in IndexedDB (hundreds of MB to GB)
// instead of localStorage (~5 MB), which is what caused "storage is full"
// errors. Covers are kept as Blobs and exposed to the UI as object URLs, so
// the metadata JSON stays tiny.

const DB_NAME = "wicked_store";
const DB_VERSION = 1;
const META = "meta";
const COVERS = "covers";

let _db: IDBDatabase | null = null;

function open(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(COVERS)) db.createObjectStore(COVERS);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | null): Promise<T | null> {
  return open().then(db => new Promise<T | null>((res, rej) => {
    const t = db.transaction(store, mode);
    const request = fn(t.objectStore(store));
    t.onerror = () => rej(t.error);
    t.oncomplete = () => res(request ? (request.result as T) : null);
  }));
}

const get = <T,>(store: string, key: string) => tx<T>(store, "readonly", s => s.get(key) as IDBRequest<T>);
const put = (store: string, key: string, val: unknown) => tx(store, "readwrite", s => { s.put(val, key); return null; });
const del = (store: string, key: string) => tx(store, "readwrite", s => { s.delete(key); return null; });
const keys = (store: string) => tx<IDBValidKey[]>(store, "readonly", s => s.getAllKeys());

// ── Cover blob <-> reference plumbing ──────────────────────────────────────

const COVER_REF = "idb:";
/** in-memory string (object URL or data URL) -> stored cover key */
const refByUrl = new Map<string, string>();
/** stored cover key -> live object URL */
const urlByKey = new Map<string, string>();

async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  try {
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch {
    return null;
  }
}

/** Stores a cover image and returns the object URL to keep in React state. */
export async function saveCover(source: Blob | string): Promise<string> {
  const blob = typeof source === "string" ? await dataUrlToBlob(source) : source;
  if (!blob) return typeof source === "string" ? source : "";
  const key = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await put(COVERS, key, blob);
  const url = URL.createObjectURL(blob);
  refByUrl.set(url, key);
  urlByKey.set(key, url);
  return url;
}

/** Converts an in-memory cover value into a persistable reference. */
async function toRef(value: string | null): Promise<string | null> {
  if (!value) return null;
  if (value.startsWith(COVER_REF)) return value;
  const known = refByUrl.get(value);
  if (known) return COVER_REF + known;
  if (value.startsWith("data:")) {
    const blob = await dataUrlToBlob(value);
    if (!blob) return null;
    const key = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await put(COVERS, key, blob);
    refByUrl.set(value, key);
    urlByKey.set(key, value);
    return COVER_REF + key;
  }
  // blob: URL we don't own (e.g. from this session before migration) — drop it
  // rather than persist a link that dies on reload.
  return null;
}

/** Turns a persisted reference back into a usable URL. */
async function fromRef(value: string | null): Promise<string | null> {
  if (!value) return null;
  if (!value.startsWith(COVER_REF)) return value; // legacy data: URL
  const key = value.slice(COVER_REF.length);
  const cached = urlByKey.get(key);
  if (cached) return cached;
  const blob = await get<Blob>(COVERS, key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlByKey.set(key, url);
  refByUrl.set(url, key);
  return url;
}

type WithCover = { coverDataUrl?: string | null };

async function mapCovers<T extends WithCover>(list: T[], fn: (v: string | null) => Promise<string | null>): Promise<T[]> {
  return Promise.all(list.map(async item => ({ ...item, coverDataUrl: await fn(item.coverDataUrl ?? null) })));
}

// ── Public API ─────────────────────────────────────────────────────────────

export type StoreKey = "projects" | "playlists" | "liked" | "favorites" | "folders";

const LEGACY_KEYS: Record<StoreKey, string> = {
  projects: "melodia_projects",
  playlists: "melodia_playlists",
  liked: "melodia_liked",
  favorites: "melodia_favorites",
  folders: "melodia_folders",
};

const HAS_COVERS: StoreKey[] = ["projects", "playlists"];

/** Reads one collection, resolving cover references to object URLs. */
export async function loadCollection<T>(key: StoreKey): Promise<T[]> {
  let raw = await get<unknown[]>(META, key);
  if (!raw) {
    // one-time migration out of localStorage
    try {
      const legacy = localStorage.getItem(LEGACY_KEYS[key]);
      if (legacy) {
        raw = JSON.parse(legacy) as unknown[];
        await saveCollection(key, raw as T[]);
        try { localStorage.removeItem(LEGACY_KEYS[key]); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  if (!Array.isArray(raw)) return [];
  if (!HAS_COVERS.includes(key)) return raw as T[];
  return (await mapCovers(raw as WithCover[], fromRef)) as T[];
}

/** Writes one collection, moving cover images into blob storage. */
export async function saveCollection<T>(key: StoreKey, list: T[]): Promise<void> {
  const payload = HAS_COVERS.includes(key)
    ? await mapCovers(list as WithCover[], toRef)
    : list;
  await put(META, key, payload);
}

/** Removes cover blobs no longer referenced by any collection. */
export async function gcCovers(): Promise<void> {
  const used = new Set<string>();
  for (const key of HAS_COVERS) {
    const raw = await get<WithCover[]>(META, key);
    for (const item of raw ?? []) {
      const v = item?.coverDataUrl;
      if (v && v.startsWith(COVER_REF)) used.add(v.slice(COVER_REF.length));
    }
  }
  const all = (await keys(COVERS)) ?? [];
  for (const k of all) {
    const id = String(k);
    if (!used.has(id)) {
      await del(COVERS, id);
      const url = urlByKey.get(id);
      if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } urlByKey.delete(id); refByUrl.delete(url); }
    }
  }
}

/** Wipes every collection and cover blob. */
export async function clearAll(): Promise<void> {
  for (const key of Object.keys(LEGACY_KEYS) as StoreKey[]) {
    await put(META, key, []);
    try { localStorage.removeItem(LEGACY_KEYS[key]); } catch { /* ignore */ }
  }
  await gcCovers();
}

/** Best-effort storage report for the settings screen. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}

/** Asks the browser to make storage persistent so nothing gets evicted. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
