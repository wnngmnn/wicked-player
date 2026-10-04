// ── Local music library on disk (iTunes-style) ─────────────────────────────
// Uses the File System Access API so audio files live in real folders on the
// user's computer. There is one MAIN folder (new uploads + tagging are written
// here) and any number of EXTRA folders that are only read from.

const DB_NAME = "wicked_fs";
const STORE = "handles";
const KEY = "libraryDir";
const EXTRA_KEY = "extraDirs";

/** Source id of the main folder. Extra folders use their own generated ids. */
export const MAIN_SOURCE = "main";

type PermissionState = "granted" | "denied" | "prompt";

interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  values?: () => AsyncIterableIterator<FileSystemHandle>;
}

interface ExtraEntry { id: string; handle: DirHandle }

export interface FolderInfo {
  id: string;
  name: string;
  role: "main" | "extra";
  perm: "granted" | "prompt";
}

let _db: IDBDatabase | null = null;
let _dir: DirHandle | null = null;
let _extras: ExtraEntry[] | null = null;

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

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openHandleDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openHandleDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => res((req.result as T) ?? null);
    req.onerror = () => rej(req.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openHandleDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export function isFsSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

async function showPicker(id: string, mode: "read" | "readwrite"): Promise<DirHandle | null> {
  try {
    const picker = (window as unknown as {
      showDirectoryPicker: (o: unknown) => Promise<DirHandle>;
    }).showDirectoryPicker;
    return await picker({ id, mode, startIn: "music" });
  } catch {
    return null; // cancelled
  }
}

async function mainHandle(): Promise<DirHandle | null> {
  if (_dir) return _dir;
  try { _dir = await idbGet<DirHandle>(KEY); } catch { _dir = null; }
  return _dir;
}

async function extras(): Promise<ExtraEntry[]> {
  if (_extras) return _extras;
  try { _extras = (await idbGet<ExtraEntry[]>(EXTRA_KEY)) ?? []; } catch { _extras = []; }
  return _extras;
}

async function permOf(dir: DirHandle, mode: "read" | "readwrite"): Promise<"granted" | "prompt"> {
  try {
    const s = (await dir.queryPermission?.({ mode })) ?? "granted";
    return s === "granted" ? "granted" : "prompt";
  } catch { return "prompt"; }
}

/** Ensures permission. Never throws: outside a user gesture a request just fails quietly. */
async function ensure(dir: DirHandle, mode: "read" | "readwrite", request: boolean): Promise<boolean> {
  if ((await permOf(dir, mode)) === "granted") return true;
  if (!request) return false;
  try {
    return ((await dir.requestPermission?.({ mode })) ?? "denied") === "granted";
  } catch {
    return false;
  }
}

/** Ask the user to choose (or re-choose) the MAIN music library folder. */
export async function pickLibraryFolder(): Promise<string | null> {
  if (!isFsSupported()) return null;
  const dir = await showPicker("wicked-library", "readwrite");
  if (!dir) return null;
  await idbSet(KEY, dir);
  _dir = dir;
  return dir.name;
}

/** Adds an extra (read-only) folder. Returns its id, or null if cancelled / duplicate. */
export async function addExtraFolder(): Promise<{ id: string; name: string } | null> {
  if (!isFsSupported()) return null;
  const dir = await showPicker("wicked-extra", "read");
  if (!dir) return null;
  const list = await extras();
  const main = await mainHandle();
  for (const e of list) {
    try { if (await e.handle.isSameEntry(dir)) return { id: e.id, name: e.handle.name }; } catch { /* ignore */ }
  }
  if (main) {
    try { if (await main.isSameEntry(dir)) return { id: MAIN_SOURCE, name: main.name }; } catch { /* ignore */ }
  }
  const id = `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  _extras = [...list, { id, handle: dir }];
  await idbSet(EXTRA_KEY, _extras);
  return { id, name: dir.name };
}

export async function removeExtraFolder(id: string): Promise<void> {
  const list = await extras();
  _extras = list.filter(e => e.id !== id);
  await idbSet(EXTRA_KEY, _extras);
}

export async function listFolders(): Promise<FolderInfo[]> {
  if (!isFsSupported()) return [];
  const out: FolderInfo[] = [];
  const main = await mainHandle();
  if (main) out.push({ id: MAIN_SOURCE, name: main.name, role: "main", perm: await permOf(main, "readwrite") });
  for (const e of await extras()) {
    out.push({ id: e.id, name: e.handle.name, role: "extra", perm: await permOf(e.handle, "read") });
  }
  return out;
}

/** Re-requests access to every saved folder. Call from a click / key press. */
export async function requestAllPermissions(): Promise<boolean> {
  let all = true;
  const main = await mainHandle();
  if (main && !(await ensure(main, "readwrite", true))) all = false;
  for (const e of await extras()) {
    if (!(await ensure(e.handle, "read", true))) all = false;
  }
  return all;
}

export async function anyFolderNeedsPermission(): Promise<boolean> {
  return (await listFolders()).some(f => f.perm !== "granted");
}

export async function getSavedLibraryName(): Promise<string | null> {
  if (!isFsSupported()) return null;
  return (await mainHandle())?.name ?? null;
}

/**
 * Returns the main library folder handle if usable.
 * `request: true` may show a permission prompt — only works from a user gesture.
 */
export async function getLibraryDir(request = false): Promise<DirHandle | null> {
  if (!isFsSupported()) return null;
  const dir = await mainHandle();
  if (!dir) return null;
  return (await ensure(dir, "readwrite", request)) ? dir : null;
}

async function sourceDir(source: string | undefined, request: boolean): Promise<DirHandle | null> {
  if (!isFsSupported()) return null;
  if (!source || source === MAIN_SOURCE) return getLibraryDir(request);
  const e = (await extras()).find(x => x.id === source);
  if (!e) return null;
  return (await ensure(e.handle, "read", request)) ? e.handle : null;
}

export async function libraryPermissionState(): Promise<"none" | "granted" | "prompt"> {
  if (!isFsSupported()) return "none";
  const dir = await mainHandle();
  if (!dir) return "none";
  return permOf(dir, "readwrite");
}

export async function forgetLibraryFolder(): Promise<void> {
  _dir = null;
  await idbDel(KEY);
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").slice(-120);
}

/** Writes a file into the main library folder. Returns its stored file name. */
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
  const writable = await handle.createWritable();
  await writable.write(file as Blob);
  await writable.close();
  return fileName;
}

async function resolveFile(dir: DirHandle, path: string, create = false): Promise<FileSystemFileHandle> {
  const parts = path.split("/").filter(Boolean);
  let cur: FileSystemDirectoryHandle = dir;
  for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i]);
  return cur.getFileHandle(parts[parts.length - 1], { create });
}

/** Reads a file back from its folder (path may include sub-folders). */
export async function readAudioFile(
  fileName: string,
  request = false,
  source?: string,
): Promise<File | null> {
  const dir = await sourceDir(source, request);
  if (!dir) return null;
  try {
    return await (await resolveFile(dir, fileName)).getFile();
  } catch {
    return null;
  }
}

export async function deleteAudioFile(fileName: string, source?: string): Promise<void> {
  // Never delete files from extra folders — those belong to the user.
  if (source && source !== MAIN_SOURCE) return;
  const dir = await getLibraryDir(false);
  if (!dir) return;
  try { await dir.removeEntry(fileName); } catch { /* already gone */ }
}

/** Replaces the contents of an existing file (used when re-tagging). */
export async function overwriteAudioFile(fileName: string, blob: Blob, source?: string): Promise<boolean> {
  let dir: DirHandle | null = null;
  if (!source || source === MAIN_SOURCE) dir = await getLibraryDir(true);
  else {
    const e = (await extras()).find(x => x.id === source);
    if (e && (await ensure(e.handle, "readwrite", true))) dir = e.handle;
  }
  if (!dir) return false;
  try {
    const handle = await resolveFile(dir, fileName, true);
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm)$/i;

/** Recursively lists every audio file in a folder (path relative to the folder root). */
export async function scanFolderFiles(
  source: string,
  onFile?: (count: number) => void,
): Promise<{ path: string; file: File }[]> {
  const dir = await sourceDir(source, true);
  if (!dir) return [];
  const out: { path: string; file: File }[] = [];
  const walk = async (d: DirHandle, prefix: string, depth: number) => {
    if (depth > 12 || !d.values) return;
    for await (const entry of d.values()) {
      if (entry.name.startsWith(".")) continue;
      if (entry.kind === "directory") {
        await walk(entry as DirHandle, `${prefix}${entry.name}/`, depth + 1);
      } else if (AUDIO_RE.test(entry.name)) {
        try {
          out.push({ path: prefix + entry.name, file: await (entry as FileSystemFileHandle).getFile() });
          onFile?.(out.length);
        } catch { /* unreadable */ }
      }
    }
  };
  await walk(dir, "", 0);
  return out;
}
