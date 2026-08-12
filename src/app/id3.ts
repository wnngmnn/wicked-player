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
  const body = new Uint8Array(1 + mimeBytes.length + 1 + 1 + 2 + bytes.length);
  let o = 0;
  body[o++] = 0x00;                    // ISO-8859-1 description
  body.set(mimeBytes, o); o += mimeBytes.length;
  body[o++] = 0x00;                    // mime terminator
  body[o++] = 0x03;                    // picture type: front cover
  body[o++] = 0x00;                    // empty description
  body[o++] = 0x00;                    // (unused padding byte kept for clarity)
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

  const parts: BlobPart[] = [header, ...frames, new Uint8Array(padding), raw.subarray(start)];
  return new Blob(parts, { type: source.type || "audio/mpeg" });
}

/** True for formats this writer can tag (ID3 lives on MPEG/AAC-style files). */
export function supportsId3(fileName?: string, mime?: string): boolean {
  const name = (fileName ?? "").toLowerCase();
  if (/\.(mp3|aac)$/.test(name)) return true;
  if (!name && (mime ?? "").includes("mpeg")) return true;
  return false;
}
