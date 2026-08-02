// ── Local music library on disk (iTunes-style) ─────────────────────────────
// Uses the File System Access API so audio files live in a real folder on the
// user's computer instead of browser storage (no quota, no "file not found"
// after browser cleanup).

const DB_NAME = "wicked_fs";
const STORE = "handles";
const KEY = "libraryDir";

type PermissionState = "granted" | "denied" | "prompt";

interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<FileSystemFileHandle>;
  removeEntry: (name: string, opts?: { recursive?: boolean }) => Promise<void>;
  values: () => AsyncIterableIterator<FileSystemHandle>;
}

let _db: IDBDatabase | null = null;
let _dir: DirHandle | null = null;

function openHandleDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(value: unknown): Promise<void> {
  const db = await openHandleDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet<T>(): Promise<T | null> {
  const db = await openHandleDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => res((req.result as T) ?? null);
    req.onerror = () => rej(req.error);
  });
}

async function idbDel(): Promise<void> {
  const db = await openHandleDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export function isFsSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/** Ask the user to choose (or re-choose) the music library folder. */
export async function pickLibraryFolder(): Promise<string | null> {
  if (!isFsSupported()) return null;
  try {
    const picker = (window as unknown as {
      showDirectoryPicker: (o: unknown) => Promise<DirHandle>;
    }).showDirectoryPicker;
    const dir = await picker({ id: "wicked-library", mode: "readwrite", startIn: "music" });
    await idbSet(dir);
    _dir = dir;
    return dir.name;
  } catch {
    return null; // user cancelled
  }
}

export async function getSavedLibraryName(): Promise<string | null> {
  if (!isFsSupported()) return null;
  const dir = _dir ?? (await idbGet<DirHandle>());
  return dir?.name ?? null;
}

/**
 * Returns the library folder handle if usable.
 * `request: true` may show a permission prompt — only call from a user gesture.
 */
export async function getLibraryDir(request = false): Promise<DirHandle | null> {
  if (!isFsSupported()) return null;
  const dir = _dir ?? (await idbGet<DirHandle>());
  if (!dir) return null;
  _dir = dir;
  const opts = { mode: "readwrite" as const };
  const state = (await dir.queryPermission?.(opts)) ?? "granted";
  if (state === "granted") return dir;
  if (!request) return null;
  const granted = (await dir.requestPermission?.(opts)) ?? "denied";
  return granted === "granted" ? dir : null;
}

export async function libraryPermissionState(): Promise<"none" | "granted" | "prompt"> {
  if (!isFsSupported()) return "none";
  const dir = _dir ?? (await idbGet<DirHandle>());
  if (!dir) return "none";
  _dir = dir;
  const state = (await dir.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  return state === "granted" ? "granted" : "prompt";
}

export async function forgetLibraryFolder(): Promise<void> {
  _dir = null;
  await idbDel();
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").slice(-120);
}

/** Writes a file into the library folder. Returns its stored file name. */
export async function writeAudioFile(
  dir: DirHandle,
  id: string,
  file: File | Blob,
  originalName: string,
): Promise<string> {
  const ext = (originalName.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp3").toLowerCase();
  const base = sanitize(originalName.replace(/\.[^.]+$/, "")) || "track";
  const fileName = `${base}__${id}${ext}`;
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await (handle as unknown as {
    createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }>;
  }).createWritable?.() ?? await (handle as unknown as {
    createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }>;
  }).createWritable();
  await writable.write(file as Blob);
  await writable.close();
  return fileName;
}

/** Reads a file back from the library folder. */
export async function readAudioFile(
  fileName: string,
  request = false,
): Promise<File | null> {
  const dir = await getLibraryDir(request);
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(fileName);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function deleteAudioFile(fileName: string): Promise<void> {
  const dir = await getLibraryDir(false);
  if (!dir) return;
  try { await dir.removeEntry(fileName); } catch { /* already gone */ }
}
