// ── Listening stats ("Wrapped") ────────────────────────────────────────────
// Listening time is accumulated into hourly local-time buckets in IndexedDB.
// Hourly granularity keeps records tiny while still letting periods start at
// 9:00 PM local time (Sunday for weeks, the 1st for months, Dec 31 for years).

const DB_NAME = "wicked_stats";
const DB_VERSION = 1;
const STORE = "buckets";

let _db: IDBDatabase | null = null;

function open(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db!); };
    req.onerror = () => reject(req.error);
  });
}

export interface SongStat {
  key: string;
  name: string;
  artist: string;
  projectId: string;
  trackId: string;
  album: string;
  plays: number;
  ms: number;
}

export interface Bucket {
  /** local hour key: YYYY-MM-DDTHH */
  key: string;
  ms: number;
  songs: Record<string, SongStat>;
  albums: Record<string, { id: string; name: string; artist: string; ms: number; plays: number }>;
  artists: Record<string, { name: string; ms: number; plays: number }>;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function bucketKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
}

export function keyToDate(key: string): Date {
  const [date, hour] = key.split("T");
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, Number(hour));
}

function emptyBucket(key: string): Bucket {
  return { key, ms: 0, songs: {}, albums: {}, artists: {} };
}

// ── Write path ─────────────────────────────────────────────────────────────

let pending: Bucket | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/** Subscribe to stat changes (so open panels refresh live). */
export function onStatsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function readBucket(key: string): Promise<Bucket | null> {
  const db = await open();
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => res((req.result as Bucket) ?? null);
    req.onerror = () => rej(req.error);
  });
}

function mergeInto(target: Bucket, add: Bucket): Bucket {
  target.ms += add.ms;
  for (const [k, v] of Object.entries(add.songs)) {
    const cur = target.songs[k];
    if (cur) { cur.ms += v.ms; cur.plays += v.plays; cur.name = v.name; cur.artist = v.artist; cur.album = v.album; }
    else target.songs[k] = { ...v };
  }
  for (const [k, v] of Object.entries(add.albums)) {
    const cur = target.albums[k];
    if (cur) { cur.ms += v.ms; cur.plays += v.plays; cur.name = v.name; cur.artist = v.artist; }
    else target.albums[k] = { ...v };
  }
  for (const [k, v] of Object.entries(add.artists)) {
    const cur = target.artists[k];
    if (cur) { cur.ms += v.ms; cur.plays += v.plays; }
    else target.artists[k] = { ...v };
  }
  return target;
}

async function flush(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const batch = pending;
  pending = null;
  if (!batch || (batch.ms === 0 && Object.keys(batch.songs).length === 0)) return;
  try {
    const existing = (await readBucket(batch.key)) ?? emptyBucket(batch.key);
    const merged = mergeInto(existing, batch);
    const db = await open();
    await new Promise<void>((res, rej) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(merged);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    for (const fn of listeners) fn();
  } catch { /* best-effort telemetry */ }
}

export function flushStats(): void { void flush(); }

function schedule() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, 4_000);
}

export interface TrackRef {
  projectId: string;
  trackId: string;
  title: string;
  artist: string;
  album: string;
}

function stage(now: Date): Bucket {
  const key = bucketKey(now);
  if (!pending || pending.key !== key) {
    if (pending) void flush();
    pending = emptyBucket(key);
  }
  return pending;
}

/** Records listening time (ms) for a track. */
export function recordListen(ref: TrackRef, ms: number): void {
  if (ms <= 0) return;
  const b = stage(new Date());
  b.ms += ms;
  const sk = `${ref.projectId}:${ref.trackId}`;
  const song = (b.songs[sk] ??= { key: sk, name: ref.title, artist: ref.artist, album: ref.album, projectId: ref.projectId, trackId: ref.trackId, plays: 0, ms: 0 });
  song.ms += ms;
  const album = (b.albums[ref.projectId] ??= { id: ref.projectId, name: ref.album, artist: ref.artist, ms: 0, plays: 0 });
  album.ms += ms;
  const artistName = ref.artist || "Unknown Artist";
  const artist = (b.artists[artistName] ??= { name: artistName, ms: 0, plays: 0 });
  artist.ms += ms;
  schedule();
}

/** Records one completed play (counted once a track is listened long enough). */
export function recordPlay(ref: TrackRef): void {
  const b = stage(new Date());
  const sk = `${ref.projectId}:${ref.trackId}`;
  const song = (b.songs[sk] ??= { key: sk, name: ref.title, artist: ref.artist, album: ref.album, projectId: ref.projectId, trackId: ref.trackId, plays: 0, ms: 0 });
  song.plays += 1;
  const album = (b.albums[ref.projectId] ??= { id: ref.projectId, name: ref.album, artist: ref.artist, ms: 0, plays: 0 });
  album.plays += 1;
  const artistName = ref.artist || "Unknown Artist";
  const artist = (b.artists[artistName] ??= { name: artistName, ms: 0, plays: 0 });
  artist.plays += 1;
  schedule();
}

// ── Read path ──────────────────────────────────────────────────────────────

async function allBuckets(): Promise<Bucket[]> {
  const db = await open();
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => res((req.result as Bucket[]) ?? []);
    req.onerror = () => rej(req.error);
  });
}

export type PeriodKind = "day" | "week" | "month" | "year";

export interface Period {
  kind: PeriodKind;
  start: Date;
  end: Date;
  label: string;
}

const RESET_HOUR = 21; // 9:00 PM local

function atHour(y: number, m: number, d: number, h: number) { return new Date(y, m, d, h, 0, 0, 0); }

/** Start boundary of the period containing `now`, shifted back `offset` periods. */
export function periodFor(kind: PeriodKind, offset = 0, now = new Date()): Period {
  let start: Date;
  let end: Date;
  if (kind === "day") {
    start = atHour(now.getFullYear(), now.getMonth(), now.getDate() - offset, 0);
    end = atHour(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0);
  } else if (kind === "week") {
    let cand = atHour(now.getFullYear(), now.getMonth(), now.getDate(), RESET_HOUR);
    cand = atHour(cand.getFullYear(), cand.getMonth(), cand.getDate() - cand.getDay(), RESET_HOUR);
    if (cand > now) cand = atHour(cand.getFullYear(), cand.getMonth(), cand.getDate() - 7, RESET_HOUR);
    start = atHour(cand.getFullYear(), cand.getMonth(), cand.getDate() - 7 * offset, RESET_HOUR);
    end = atHour(start.getFullYear(), start.getMonth(), start.getDate() + 7, RESET_HOUR);
  } else if (kind === "month") {
    let cand = atHour(now.getFullYear(), now.getMonth(), 1, RESET_HOUR);
    if (cand > now) cand = atHour(now.getFullYear(), now.getMonth() - 1, 1, RESET_HOUR);
    start = atHour(cand.getFullYear(), cand.getMonth() - offset, 1, RESET_HOUR);
    end = atHour(start.getFullYear(), start.getMonth() + 1, 1, RESET_HOUR);
  } else {
    let cand = atHour(now.getFullYear(), 11, 31, RESET_HOUR);
    if (cand > now) cand = atHour(now.getFullYear() - 1, 11, 31, RESET_HOUR);
    start = atHour(cand.getFullYear() - offset, 11, 31, RESET_HOUR);
    end = atHour(start.getFullYear() + 1, 11, 31, RESET_HOUR);
  }
  return { kind, start, end, label: labelFor(kind, start, end, offset) };
}

function labelFor(kind: PeriodKind, start: Date, end: Date, offset: number): string {
  const md: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (kind === "day") {
    if (offset === 0) return "Today";
    if (offset === 1) return "Yesterday";
    return start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }
  if (kind === "week") {
    const last = new Date(end.getTime() - 1);
    const range = `${start.toLocaleDateString(undefined, md)} – ${last.toLocaleDateString(undefined, md)}`;
    return offset === 0 ? `This week · ${range}` : range;
  }
  if (kind === "month") {
    const mid = new Date(start.getTime() + 15 * 86400000);
    const name = mid.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    return offset === 0 ? `This month · ${name}` : name;
  }
  const year = start.getFullYear() + 1;
  return offset === 0 ? `This year · ${year}` : String(year);
}

export interface PeriodStats {
  ms: number;
  songs: SongStat[];
  albums: { id: string; name: string; artist: string; ms: number; plays: number }[];
  artists: { name: string; ms: number; plays: number }[];
  /** ms per calendar day inside the period, ordered oldest → newest. */
  daily: { date: Date; ms: number }[];
}

/** Aggregates every hourly bucket that falls inside a period. */
export async function statsFor(period: Period): Promise<PeriodStats> {
  const buckets = await allBuckets();
  const live = pending ? [pending] : [];
  const agg = emptyBucket("agg");
  const byDay = new Map<string, number>();
  for (const b of [...buckets, ...live]) {
    const d = keyToDate(b.key);
    if (d < period.start || d >= period.end) continue;
    mergeInto(agg, b);
    const dk = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    byDay.set(dk, (byDay.get(dk) ?? 0) + b.ms);
  }
  const daily = [...byDay.entries()]
    .map(([k, ms]) => {
      const [y, m, d] = k.split("-").map(Number);
      return { date: new Date(y, m - 1, d), ms };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  return {
    ms: agg.ms,
    songs: Object.values(agg.songs).sort((a, b) => b.plays - a.plays || b.ms - a.ms),
    albums: Object.values(agg.albums).sort((a, b) => b.ms - a.ms),
    artists: Object.values(agg.artists).sort((a, b) => b.ms - a.ms),
    daily,
  };
}

/** How many past periods actually contain listening data (for the back arrow). */
export async function earliestBucket(): Promise<Date | null> {
  const all = await allBuckets();
  if (!all.length) return null;
  return all.map(b => keyToDate(b.key)).sort((a, b) => a.getTime() - b.getTime())[0];
}

export async function clearStats(): Promise<void> {
  pending = null;
  const db = await open();
  await new Promise<void>((res, rej) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).clear();
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
  for (const fn of listeners) fn();
}
