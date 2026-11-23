import { zip, unzip, strToU8, strFromU8 } from 'fflate';
import { z } from 'zod';

// ZIP volumes stay below 200 MB, even when a single song is larger than that.
export const VOLUME_BYTES = 180 * 1024 * 1024;
const MAX_VOLUME_BYTES = 195 * 1024 * 1024;
const MAX_PARTS = 200;
const trackSchema = z.object({ name: z.string().max(1000), duration: z.number().finite().nonnegative(), lyrics: z.string().max(100000).optional(), size: z.number().int().positive() });
const segmentSchema = z.object({ track: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), size: z.number().int().positive() });
export const manifestSchema = z.object({
  format: z.literal('wicked-album'), version: z.literal(1), id: z.string().uuid(),
  name: z.string().min(1).max(1000), artist: z.string().max(1000),
  year: z.number().int().optional(), genre: z.string().max(1000).optional(), discNumber: z.number().int().positive().optional(), isSingle: z.boolean().optional(),
  tracks: z.array(trackSchema).min(1).max(5000),
  parts: z.array(z.array(segmentSchema).min(1)).min(1).max(MAX_PARTS),
});
export type AlbumManifest = z.infer<typeof manifestSchema>;
export type ShareAlbum = Omit<AlbumManifest, 'format' | 'version' | 'id' | 'parts' | 'tracks'> & { coverDataUrl: string | null; tracks: { name: string; duration: number; lyrics?: string }[] };
export type PreparedAlbum = { manifest: AlbumManifest; files: Blob[]; cover: Blob | null };

export function planVolumes(sizes: number[], limit = VOLUME_BYTES): AlbumManifest['parts'] {
  if (!sizes.length || !Number.isSafeInteger(limit) || limit < 1) throw new Error('No songs to share.');
  const parts: AlbumManifest['parts'] = [];
  let part: AlbumManifest['parts'][number] = [], used = 0;
  sizes.forEach((size, track) => {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('A song file is empty or invalid.');
    for (let offset = 0; offset < size;) {
      const length = Math.min(size - offset, limit - used);
      part.push({ track, offset, size: length }); used += length; offset += length;
      if (used === limit) { parts.push(part); part = []; used = 0; }
    }
  });
  if (part.length) parts.push(part);
  if (parts.length > MAX_PARTS) throw new Error('This album is too large for one share. Share fewer tracks at a time.');
  return parts;
}

export function validateManifest(value: unknown): AlbumManifest {
  const m = manifestSchema.parse(value);
  const expected = planVolumes(m.tracks.map(t => t.size));
  if (JSON.stringify(expected) !== JSON.stringify(m.parts)) throw new Error('Invalid album file layout.');
  if (strToU8(JSON.stringify(m)).length > 1024 * 1024) throw new Error('Album information is too large.');
  return m;
}

export async function prepareAlbum(album: ShareAlbum, load: (index: number) => Promise<Blob>, progress: (message: string) => void): Promise<PreparedAlbum> {
  const files: Blob[] = [];
  for (let i = 0; i < album.tracks.length; i++) { progress(`Reading song ${i + 1} of ${album.tracks.length}…`); files.push(await load(i)); }
  const cover = album.coverDataUrl ? await (await fetch(album.coverDataUrl)).blob() : null;
  if (cover && (cover.size > 4 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(cover.type))) throw new Error('Use a JPG, PNG or WebP cover smaller than 4 MB.');
  const manifest = validateManifest({ ...album, format: 'wicked-album', version: 1, id: crypto.randomUUID(), tracks: album.tracks.map((t, i) => ({ ...t, size: files[i]?.size ?? 0 })), parts: planVolumes(files.map(f => f.size)) });
  return { manifest, files, cover };
}

export async function buildVolume(album: PreparedAlbum, index: number): Promise<Blob> {
  const segments = album.manifest.parts[index];
  if (!segments) throw new Error('Missing album part.');
  const entries: Record<string, Uint8Array> = { 'album.json': strToU8(JSON.stringify({ album: album.manifest, part: index })) };
  if (album.cover) entries['cover'] = new Uint8Array(await album.cover.arrayBuffer());
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]; if (!s) continue;
    const file = album.files[s.track]; if (!file) throw new Error('Missing song file.');
    entries[`audio/${i}`] = new Uint8Array(await file.slice(s.offset, s.offset + s.size).arrayBuffer());
  }
  return new Promise((resolve, reject) => zip(entries, { level: 0 }, (err, data) => err ? reject(err) : resolve(new Blob([new Uint8Array(data)], { type: 'application/zip' }))));
}

export async function readVolume(blob: Blob): Promise<{ manifest: AlbumManifest; part: number; entries: Record<string, Uint8Array> }> {
  if (blob.size > MAX_VOLUME_BYTES) throw new Error('This ZIP is too large. Choose a Wicked album part.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let total = 0, invalid = false;
    unzip(bytes, { filter: entry => {
      total += entry.originalSize;
      const allowed = entry.name === 'album.json' || entry.name === 'cover' || /^audio\/\d+$/.test(entry.name);
      if (!allowed || total > MAX_VOLUME_BYTES || (entry.name === 'album.json' && entry.originalSize > 1024 * 1024) || (entry.name === 'cover' && entry.originalSize > 4 * 1024 * 1024)) { invalid = true; return false; }
      return true;
    } }, (err, data) => err ? reject(new Error('This is not a readable Wicked ZIP.')) : invalid ? reject(new Error('Unsafe or oversized album ZIP.')) : resolve(data));
  });
  const json = entries['album.json']; if (!json) throw new Error('This ZIP does not contain Wicked album information.');
  const parsed = z.object({ album: z.unknown(), part: z.number().int().nonnegative() }).parse(JSON.parse(strFromU8(json)));
  const manifest = validateManifest(parsed.album);
  const segments = manifest.parts[parsed.part]; if (!segments) throw new Error('Invalid album part number.');
  if (Object.keys(entries).length !== segments.length + 1 + (entries['cover'] ? 1 : 0)) throw new Error('Unexpected files in album ZIP.');
  segments.forEach((s, i) => { if (entries[`audio/${i}`]?.length !== s.size) throw new Error('A song is missing or incomplete.'); });
  return { manifest, part: parsed.part, entries };
}

export function parseFileIds(text: string): string[] {
  const values = text.trim().split(/[\s,]+/).filter(Boolean);
  if (!values.length || values.length > MAX_PARTS) throw new Error('Add a Pixeldrain link for each ZIP part.');
  return values.map(value => {
    if (/^[A-Za-z0-9]{8}$/.test(value)) return value;
    let url: URL; try { url = new URL(value); } catch { throw new Error('Use Pixeldrain file links, not folders or other websites.'); }
    const match = /^\/u\/([A-Za-z0-9]{8})\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || !['pixeldrain.com', 'pixeldrain.net'].includes(url.hostname) || !match?.[1]) throw new Error('Use Pixeldrain file links, not folders or other websites.');
    return match[1];
  });
}
export function encodeShare(ids: string[]): string { return ids.join(','); }
export function decodeShare(value: string): string[] { return parseFileIds(value); }
export function shareUrl(ids: string[]): string { return `${location.origin}${location.pathname}#/import/${encodeShare(ids)}`; }
export function downloadVolume(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function fetchVolume(id: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(`https://pixeldrain.com/api/file/${id}`, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`Pixeldrain could not download this part (${response.status}). Open its link on Pixeldrain, complete any required check, and import the downloaded ZIPs instead.`);
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_VOLUME_BYTES) throw new Error('Pixeldrain file is larger than a Wicked album part.');
  if (!response.body) throw new Error('Pixeldrain returned an empty download.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_VOLUME_BYTES) throw new Error('Downloaded album part is too large.'); chunks.push(new Uint8Array(value)); } }
  catch (e) { await reader.cancel(); throw e; }
  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
}
