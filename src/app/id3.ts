// ── Minimal ID3v2.3 tag writer ─────────────────────────────────────────────
// Writes real metadata into audio files (like iTunes does) so tags travel with
// the file, not just inside the app's library database.

export interface Id3Tags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  genre?: string;
  /** 1-based track position within the disc. */
  track?: number;
  trackTotal?: number;
  disc?: number;
  discTotal?: number;
  year?: number;
  cover?: { mime: string; bytes: Uint8Array } | null;
}

/** UTF-16LE with BOM (ID3v2.3 text encoding 0x01) — safe for any characters. */
function encodeText(value: string): Uint8Array {
  const out = new Uint8Array(2 + value.length * 2 + 2);
  out[0] = 0xff; out[1] = 0xfe; // BOM
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[3 + i * 2] = code >> 8;
  }
  return out; // trailing 0x00 0x00 terminator
}

function latin1(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
  return out;
}

function frame(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(10 + body.length);
  out.set(latin1(id), 0);
  const size = body.length;
  out[4] = (size >>> 24) & 0xff;
  out[5] = (size >>> 16) & 0xff;
  out[6] = (size >>> 8) & 0xff;
  out[7] = size & 0xff;
  out.set(body, 10);
  return out;
}

function textFrame(id: string, value: string): Uint8Array {
  const text = encodeText(value);
  const body = new Uint8Array(1 + text.length);
  body[0] = 0x01;
  body.set(text, 1);
  return frame(id, body);
}

function apicFrame(mime: string, bytes: Uint8Array): Uint8Array {
  const mimeBytes = latin1(mime);
  const body = new Uint8Array(1 + mimeBytes.length + 1 + 1 + 1 + bytes.length);
  let o = 0;
  body[o++] = 0x00;                    // ISO-8859-1 description
  body.set(mimeBytes, o); o += mimeBytes.length;
  body[o++] = 0x00;                    // mime terminator
  body[o++] = 0x03;                    // picture type: front cover
  body[o++] = 0x00;                    // empty description
  body.set(bytes, o);
  return frame("APIC", body.subarray(0, o + bytes.length));
}

function syncsafe(size: number): Uint8Array {
  return new Uint8Array([
    (size >>> 21) & 0x7f,
    (size >>> 14) & 0x7f,
    (size >>> 7) & 0x7f,
    size & 0x7f,
  ]);
}

/** Byte offset where the audio data starts (skips any existing ID3v2 tag). */
function audioStart(view: Uint8Array): number {
  if (view.length < 10) return 0;
  if (view[0] !== 0x49 || view[1] !== 0x44 || view[2] !== 0x33) return 0; // "ID3"
  const size = ((view[6] & 0x7f) << 21) | ((view[7] & 0x7f) << 14) | ((view[8] & 0x7f) << 7) | (view[9] & 0x7f);
  const footer = (view[5] & 0x10) ? 10 : 0;
  return Math.min(view.length, 10 + size + footer);
}

/** Returns a new Blob with the given tags written as an ID3v2.3 tag. */
export async function writeId3Tags(source: Blob, tags: Id3Tags): Promise<Blob> {
  const raw = new Uint8Array(await source.arrayBuffer());
  const start = audioStart(raw);

  const frames: Uint8Array[] = [];
  const push = (id: string, value?: string) => {
    if (value && value.trim()) frames.push(textFrame(id, value.trim()));
  };
  push("TIT2", tags.title);
  push("TPE1", tags.artist);
  push("TPE2", tags.albumArtist);
  push("TALB", tags.album);
  push("TCON", tags.genre);
  if (tags.track) push("TRCK", tags.trackTotal ? `${tags.track}/${tags.trackTotal}` : String(tags.track));
  if (tags.disc) push("TPOS", tags.discTotal ? `${tags.disc}/${tags.discTotal}` : String(tags.disc));
  if (tags.year) push("TYER", String(tags.year));
  if (tags.cover && tags.cover.bytes.length) frames.push(apicFrame(tags.cover.mime, tags.cover.bytes));

  const framesSize = frames.reduce((n, f) => n + f.length, 0);
  const padding = 1024;
  const header = new Uint8Array(10);
  header.set(latin1("ID3"), 0);
  header[3] = 0x03; header[4] = 0x00; header[5] = 0x00;
  header.set(syncsafe(framesSize + padding), 6);

  const parts = [header, ...frames, new Uint8Array(padding), raw.subarray(start)] as unknown as BlobPart[];
  return new Blob(parts, { type: source.type || "audio/mpeg" });
}

/** True for formats this writer can tag (ID3 lives on MPEG/AAC-style files). */
export function supportsId3(fileName?: string, mime?: string): boolean {
  const name = (fileName ?? "").toLowerCase();
  if (/\.(mp3|aac)$/.test(name)) return true;
  if (!name && (mime ?? "").includes("mpeg")) return true;
  return false;
}

// ── Minimal ID3v2.2/2.3/2.4 tag reader ─────────────────────────────────────

export interface ReadTags {
  title?: string; artist?: string; albumArtist?: string; album?: string;
  genre?: string; track?: number; disc?: number; year?: number; lyrics?: string;
  cover?: Blob;
}

function decodeText(enc: number, b: Uint8Array): string {
  let s: string;
  try {
    if (enc === 1) s = new TextDecoder("utf-16").decode(b);
    else if (enc === 2) s = new TextDecoder("utf-16be").decode(b);
    else if (enc === 3) s = new TextDecoder("utf-8").decode(b);
    else s = new TextDecoder("latin1").decode(b);
  } catch { s = ""; }
  return s.replace(/\u0000+$/g, "").split("\u0000")[0].replace(/^\uFEFF/, "").trim();
}

function termLen(enc: number, b: Uint8Array, from: number): number {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i - from;
  } else {
    for (let i = from; i < b.length; i++) if (b[i] === 0) return i - from;
  }
  return b.length - from;
}

const syncsafe = (b: Uint8Array, o: number) =>
  ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

const GENRES = ["Blues","Classic Rock","Country","Dance","Disco","Funk","Grunge","Hip-Hop","Jazz","Metal","New Age","Oldies","Other","Pop","R&B","Rap","Reggae","Rock","Techno","Industrial","Alternative","Ska","Death Metal","Pranks","Soundtrack","Euro-Techno","Ambient","Trip-Hop","Vocal","Jazz+Funk","Fusion","Trance","Classical","Instrumental","Acid","House","Game","Sound Clip","Gospel","Noise","Alternative Rock","Bass","Soul","Punk","Space","Meditative","Instrumental Pop","Instrumental Rock","Ethnic","Gothic","Darkwave","Techno-Industrial","Electronic","Pop-Folk","Eurodance","Dream","Southern Rock","Comedy","Cult","Gangsta","Top 40","Christian Rap","Pop/Funk","Jungle","Native American","Cabaret","New Wave","Psychedelic","Rave","Showtunes","Trailer","Lo-Fi","Tribal","Acid Punk","Acid Jazz","Polka","Retro","Musical","Rock & Roll","Hard Rock"];

function cleanGenre(g: string): string {
  const m = g.match(/^\((\d+)\)(.*)$/) || g.match(/^(\d+)$/);
  if (m) return (m[2] && m[2].trim()) || GENRES[+m[1]] || g;
  return g;
}

/** Reads common ID3v2 tags from the start of a file. Never throws. */
export async function readId3Tags(file: Blob): Promise<ReadTags> {
  const out: ReadTags = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out;
    const ver = head[3];
    const size = syncsafe(head, 6);
    if (size <= 0 || size > 40_000_000) return out;
    const b = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    let p = 0;
    if (head[5] & 0x40 && ver >= 3) p += ver === 4 ? syncsafe(b, 0) : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) + 4;
    const idLen = ver === 2 ? 3 : 4;
    const hdrLen = ver === 2 ? 6 : 10;
    const map: Record<string, keyof ReadTags> = ver === 2
      ? { TT2: "title", TP1: "artist", TP2: "albumArtist", TAL: "album", TCO: "genre", TRK: "track", TPA: "disc", TYE: "year", PIC: "cover", ULT: "lyrics" }
      : { TIT2: "title", TPE1: "artist", TPE2: "albumArtist", TALB: "album", TCON: "genre", TRCK: "track", TPOS: "disc", TYER: "year", TDRC: "year", APIC: "cover", USLT: "lyrics" };
    while (p + hdrLen <= b.length) {
      const id = String.fromCharCode(...b.subarray(p, p + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break;
      const fsz = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]
        : ver === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
      const start = p + hdrLen;
      if (fsz <= 0 || start + fsz > b.length) break;
      const f = b.subarray(start, start + fsz);
      const key = map[id];
      p = start + fsz;
      if (!key || (out[key] !== undefined && key !== "year")) continue;
      const enc = f[0];
      if (key === "cover") {
        let q = 1, mime = "image/jpeg";
        if (ver === 2) { const fmt = String.fromCharCode(f[1], f[2], f[3]); mime = fmt === "PNG" ? "image/png" : "image/jpeg"; q = 4; }
        else { const ml = termLen(0, f, 1); mime = new TextDecoder("latin1").decode(f.subarray(1, 1 + ml)) || mime; q = 1 + ml + 1; }
        q += 1; // picture type
        q += termLen(enc, f, q) + (enc === 1 || enc === 2 ? 2 : 1);
        if (q < f.length) out.cover = new Blob([f.slice(q)], { type: mime.includes("/") ? mime : `image/${mime.toLowerCase()}` });
        continue;
      }
      if (key === "lyrics") {
        let q = 4; // enc + lang
        q += termLen(enc, f, q) + (enc === 1 || enc === 2 ? 2 : 1);
        const t = (() => { try { return new TextDecoder(enc === 1 ? "utf-16" : enc === 2 ? "utf-16be" : enc === 3 ? "utf-8" : "latin1").decode(f.subarray(q)); } catch { return ""; } })();
        const s = t.replace(/\u0000/g, "").trim();
        if (s) out.lyrics = s;
        continue;
      }
      const text = decodeText(enc, f.subarray(1));
      if (!text) continue;
      if (key === "track" || key === "disc") { const n = parseInt(text, 10); if (n > 0) out[key] = n; }
      else if (key === "year") { const n = parseInt(text.slice(0, 4), 10); if (n > 0 && !out.year) out.year = n; }
      else if (key === "genre") out.genre = cleanGenre(text);
      else (out as Record<string, unknown>)[key] = text;
    }
  } catch { /* corrupt tag */ }
  return out;
}
