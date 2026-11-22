// ── In-browser MP3 conversion (320 kbps, high quality) ─────────────────────
const KBPS = 320;

export function isMp3(name?: string, mime?: string): boolean {
  if (name) return /\.mp3$/i.test(name);
  return (mime ?? "").includes("mpeg");
}

function toInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Decodes any browser-playable audio and re-encodes it as a 320 kbps MP3. */
export async function convertToMp3(file: Blob): Promise<Blob> {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const ctx = new AudioContext();
  let buf: AudioBuffer;
  try { buf = await ctx.decodeAudioData(await file.arrayBuffer()); }
  finally { void ctx.close(); }
  const channels = Math.min(2, buf.numberOfChannels);
  const rate = [48000, 44100, 32000].includes(buf.sampleRate) ? buf.sampleRate : 44100;
  if (rate !== buf.sampleRate) {
    const off = new OfflineAudioContext(channels, Math.ceil(buf.duration * rate), rate);
    const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
    buf = await off.startRendering();
  }
  const enc = new Mp3Encoder(channels, rate, KBPS);
  const left = toInt16(buf.getChannelData(0));
  const right = channels > 1 ? toInt16(buf.getChannelData(1)) : undefined;
  const parts: BlobPart[] = [];
  const BLOCK = 1152 * 20;
  for (let i = 0; i < left.length; i += BLOCK) {
    const l = left.subarray(i, i + BLOCK);
    const out = right ? enc.encodeBuffer(l, right.subarray(i, i + BLOCK)) : enc.encodeBuffer(l);
    if (out.length) parts.push(new Uint8Array(out));
    if ((i / BLOCK) % 40 === 0) await new Promise(r => setTimeout(r, 0)); // keep UI responsive
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: "audio/mpeg" });
}

/** Returns an MP3 version of the file (original if already MP3 or conversion fails). */
export async function ensureMp3(file: File): Promise<File> {
  if (isMp3(file.name, file.type)) return file;
  try {
    const blob = await convertToMp3(file);
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".mp3", { type: "audio/mpeg" });
  } catch (err) {
    console.error("MP3 conversion failed", err);
    return file;
  }
}
