import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, ArrowLeft, Music, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { decodeShare, fetchVolume, readVolume, type AlbumManifest } from './album-sharing';
import { getLibraryDir, pickLibraryFolder } from './library-fs';
import { importAlbum, type ImportedAlbum } from './album-import';

export default function AlbumImportView({ token, exists, onImported, onBack }: { token: string; exists: (id: string) => boolean; onImported: (album: ImportedAlbum) => void; onBack: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [manifest, setManifest] = useState<AlbumManifest | null>(null);
  const [status, setStatus] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false); const controller = useRef<AbortController | null>(null); const first = useRef<Blob | null>(null);
  useEffect(() => () => { controller.current?.abort(); first.current = null; }, []);
  const sources = (signal: AbortSignal) => files.length ? files.map(f => async () => f) : decodeShare(token).map(id => () => fetchVolume(id, signal));
  const review = async () => {
    setBusy(true); setError(''); setStatus('Reading album information…'); const c = new AbortController(); controller.current = c;
    try { const get = sources(c.signal)[0]; if (!get) throw new Error('Select the Wicked ZIP parts you received.'); const blob = await get(); const volume = await readVolume(blob); c.signal.throwIfAborted(); if (volume.part !== 0) throw new Error('Select all ZIP parts, starting with part 1.'); const count = sources(c.signal).length; if (count !== volume.manifest.parts.length) throw new Error(`This album needs ${volume.manifest.parts.length} ZIP parts. Select them all.`); setManifest(volume.manifest); first.current = blob; }
    catch (e) { if (!c.signal.aborted) setError(e instanceof Error ? e.message : 'Pixeldrain could not be reached. Download the ZIPs on its website and select them here.'); }
    finally { setBusy(false); setStatus(''); }
  };
  useEffect(() => { if (token) void review(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    if (!manifest || exists(`shared_${manifest.id}`)) return;
    setBusy(true); setError(''); const c = new AbortController(); controller.current = c;
    try {
      let dir = await getLibraryDir(true);
      if (!dir) { if (!await pickLibraryFolder()) throw new Error('Choose your main music folder to import this album.'); dir = await getLibraryDir(true); }
      if (!dir) throw new Error('Your main music folder is not writable.');
      const gets = sources(c.signal);
      const cached = first.current; if (cached) gets[0] = async () => cached;
      const album = await importAlbum(dir, gets, manifest, c.signal, setStatus);
      onImported(album); setDone(true); first.current = null;
    } catch (e) { setError(c.signal.aborted ? 'Import cancelled. Incomplete files were removed.' : e instanceof Error ? e.message : 'Album import failed. Your existing music is unchanged.'); }
    finally { setBusy(false); setStatus(''); }
  };
  return <div className="max-w-2xl mx-auto px-6 py-10 pb-32">
    <Button variant="ghost" disabled={busy} onClick={onBack}><ArrowLeft />Library</Button>
    <div className="mt-8 border-b border-border pb-6"><Download className="size-8 text-primary mb-4" /><h1 className="text-3xl font-bold">Import album</h1></div>
    <section className="py-6 space-y-5">
      {!done && !token && <><label htmlFor="album-zip-files" className="block text-sm font-medium">Wicked album ZIPs</label><input id="album-zip-files" type="file" multiple accept=".zip,application/zip" disabled={busy} className="block w-full text-sm file:mr-4 file:rounded-md file:border file:border-border file:bg-secondary file:text-foreground file:px-4 file:py-2" onChange={e => { setFiles(Array.from(e.target.files ?? []).sort((a, b) => a.name.localeCompare(b.name))); setManifest(null); first.current = null; setError(''); }} />
      {!manifest && <Button disabled={busy || (!token && !files.length)} onClick={review}><Download />Review album</Button>}</>}
      {manifest && <div className="border-b border-border py-5"><Music className="size-7 text-muted-foreground mb-3" /><h2 className="text-2xl font-semibold break-words">{manifest.name}</h2><p className="text-muted-foreground mt-1 break-words">{manifest.artist}{manifest.year ? ` · ${manifest.year}` : ''}</p><p className="text-sm text-muted-foreground mt-3">{manifest.tracks.length} songs · {(manifest.tracks.reduce((sum, t) => sum + t.size, 0) / 1024 / 1024).toFixed(1)} MB · {manifest.parts.length} ZIP part{manifest.parts.length === 1 ? '' : 's'}</p>
      <ol className="mt-5 max-h-60 overflow-y-auto divide-y divide-border">{manifest.tracks.map((t, i) => <li className="py-2 flex gap-3 text-sm" key={i}><span className="text-muted-foreground w-6 shrink-0">{i + 1}</span><span className="break-words min-w-0">{t.name}</span></li>)}</ol></div>}
      {done ? <><p role="status" className="font-medium">Album added to your main music folder.</p><Button onClick={onBack}>Open library</Button></> : manifest && <Button disabled={busy || exists(`shared_${manifest.id}`)} onClick={start}><FolderOpen />{exists(`shared_${manifest.id}`) ? 'Already in your library' : 'Add to my music folder'}</Button>}
      {busy && <div className="flex items-center gap-3"><p role="status" className="text-sm text-muted-foreground">{status || 'Opening music folder…'}</p><Button variant="ghost" size="icon" aria-label="Cancel import" title="Cancel" onClick={() => controller.current?.abort()}><X /></Button></div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {error && token && !manifest && <Button variant="outline" disabled={busy} onClick={review}>Try again</Button>}
    </section>
  </div>;
}
