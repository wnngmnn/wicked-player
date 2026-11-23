import { readVolume, type AlbumManifest } from './album-sharing';
import { saveCover } from './storage';

export type ImportedAlbum = {
  id: string; name: string; artist: string; createdAt: number; coverDataUrl: string | null;
  year?: number; genre?: string; discNumber?: number; isSingle?: boolean;
  tracks: { id: string; name: string; duration: number; lyrics?: string; audioKey: string; filePath: string; source: string }[];
};

/** Files are committed to the library only after every volume is checked and written. */
export async function importAlbum(
  dir: FileSystemDirectoryHandle,
  sources: (() => Promise<Blob>)[],
  expected: AlbumManifest,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<ImportedAlbum> {
  if (sources.length !== expected.parts.length) throw new Error(`Select all ${expected.parts.length} album parts.`);
  const names: string[] = [];
  const tracks: ImportedAlbum['tracks'] = [];
  let active: FileSystemWritableFileStream | null = null, activeTrack = -1;
  let cover: Blob | null = null;
  const prefix = crypto.randomUUID();
  try {
    for (let part = 0; part < sources.length; part++) {
      signal.throwIfAborted(); progress(`Importing part ${part + 1} of ${sources.length}…`);
      const source = sources[part]; if (!source) throw new Error('Missing album part.');
      const volume = await readVolume(await source());
      signal.throwIfAborted();
      if (volume.part !== part || JSON.stringify(volume.manifest) !== JSON.stringify(expected)) throw new Error('These parts are out of order or belong to different albums.');
      if (part === 0 && volume.entries['cover']) {
        const bytes = volume.entries['cover'];
        const type = bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' : bytes[0] === 137 && bytes[1] === 80 ? 'image/png' : bytes[0] === 82 && bytes[8] === 87 ? 'image/webp' : '';
        if (!type) throw new Error('Album cover is not a supported image.');
        cover = new Blob([new Uint8Array(bytes)], { type });
        const bitmap = await createImageBitmap(cover);
        const pixels = bitmap.width * bitmap.height; bitmap.close();
        if (pixels > 16000000) throw new Error('Album cover is too large.');
      }
      const segments = expected.parts[part]; if (!segments) throw new Error('Missing album layout.');
      for (let i = 0; i < segments.length; i++) {
        signal.throwIfAborted();
        const segment = segments[i]; if (!segment) continue;
        const track = expected.tracks[segment.track], bytes = volume.entries[`audio/${i}`];
        if (!track || !bytes) throw new Error('Missing song data.');
        if (segment.offset === 0) {
          if (active) throw new Error('Incomplete song in previous part.');
          const id = `${prefix}_${segment.track}`;
          const name = `${String(segment.track + 1).padStart(3, '0')}_${track.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80)}__${id}.mp3`;
          names.push(name);
          const handle = await dir.getFileHandle(name, { create: true });
          active = await handle.createWritable(); activeTrack = segment.track;
          tracks.push({ id, name: track.name, duration: track.duration, ...(track.lyrics !== undefined ? { lyrics: track.lyrics } : {}), audioKey: `audio_${id}`, filePath: name, source: 'main' });
        }
        if (!active || activeTrack !== segment.track) throw new Error('Song parts are not in the correct order.');
        await active.write({ type: 'write', position: segment.offset, data: new Uint8Array(bytes) });
        if (segment.offset + segment.size === track.size) { await active.close(); active = null; activeTrack = -1; }
      }
    }
    signal.throwIfAborted();
    if (active || tracks.length !== expected.tracks.length) throw new Error('Album is incomplete.');
    const coverDataUrl = cover ? await saveCover(cover) : null;
    return { id: `shared_${expected.id}`, name: expected.name, artist: expected.artist, createdAt: Date.now(), coverDataUrl, tracks,
      ...(expected.year !== undefined ? { year: expected.year } : {}), ...(expected.genre !== undefined ? { genre: expected.genre } : {}),
      ...(expected.discNumber !== undefined ? { discNumber: expected.discNumber } : {}), ...(expected.isSingle !== undefined ? { isSingle: expected.isSingle } : {}) };
  } catch (error) {
    if (active) { try { await active.abort(); } catch { /* best effort */ } }
    for (const name of names) { try { await dir.removeEntry(name); } catch { /* do not remove anything pre-existing */ } }
    throw error;
  }
}
