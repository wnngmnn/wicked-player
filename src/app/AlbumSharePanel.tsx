import { useState } from 'react';
import { Download, Copy, ExternalLink, Link2, Check, Music } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { prepareAlbum, buildVolume, downloadVolume, parseFileIds, shareUrl, type ShareAlbum, type PreparedAlbum } from './album-sharing';

export default function AlbumSharePanel({ album, load, onClose }: { album: ShareAlbum; load: (index: number) => Promise<Blob>; onClose: () => void }) {
  const [prepared, setPrepared] = useState<PreparedAlbum | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<number[]>([]);
  const [links, setLinks] = useState('');
  const [result, setResult] = useState('');
  const [copied, setCopied] = useState(false);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Album sharing failed.'); } finally { setBusy(false); setStatus(''); } };
  const save = (index: number) => run(async () => {
    if (!prepared) return;
    setStatus(`Preparing part ${index + 1}…`);
    const blob = await buildVolume(prepared, index);
    downloadVolume(blob, `wicked-${prepared.manifest.id}-part-${String(index + 1).padStart(3, '0')}-of-${prepared.manifest.parts.length}.zip`);
    setSaved(prev => [...new Set([...prev, index])]);
  });
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto bg-background text-foreground">
      <DialogHeader><DialogTitle>Share album</DialogTitle><DialogDescription>{album.name} · {album.artist || 'Unknown artist'}</DialogDescription></DialogHeader>
      <div className="flex gap-4 items-center border-b border-border pb-5">
        {album.coverDataUrl ? <img src={album.coverDataUrl} alt="" className="size-20 object-cover rounded-md" /> : <Music className="size-16 text-muted-foreground" />}
        <div><p className="font-semibold">{album.tracks.length} songs</p><p className="text-sm text-muted-foreground mt-1">Original MP3 quality · Cover and lyrics included</p></div>
      </div>
      {!prepared ? <Button disabled={busy || !album.tracks.length} onClick={() => run(async () => setPrepared(await prepareAlbum(album, load, setStatus)))}><Download />Prepare album ZIPs</Button> : <>
        <p className="text-sm text-muted-foreground">{prepared.manifest.parts.length} ZIP part{prepared.manifest.parts.length === 1 ? '' : 's'} · Each under 200 MB</p>
        <div className="max-h-48 overflow-y-auto divide-y divide-border">
          {prepared.manifest.parts.map((_, i) => <div key={i} className="flex items-center justify-between py-2 gap-3"><span className="text-sm">Part {i + 1} of {prepared.manifest.parts.length}</span><Button variant="outline" disabled={busy} onClick={() => save(i)}>{saved.includes(i) ? <Check /> : <Download />}{saved.includes(i) ? 'Download again' : 'Download ZIP'}</Button></div>)}
        </div>
        <Button asChild variant="outline"><a href="https://pixeldrain.com" target="_blank" rel="noopener noreferrer"><ExternalLink />Upload ZIPs on Pixeldrain</a></Button>
        <label className="text-sm font-medium" htmlFor="album-part-links">Pixeldrain file links, in part order</label>
        <textarea id="album-part-links" value={links} onChange={e => { setLinks(e.target.value); setResult(''); }} placeholder="https://pixeldrain.com/u/…" rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm break-all" />
        <Button disabled={busy || !links.trim()} onClick={() => { try { const ids = parseFileIds(links); if (ids.length !== prepared.manifest.parts.length || new Set(ids).size !== ids.length) throw new Error('Add one different link for every ZIP part, in order.'); setResult(shareUrl(ids)); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Invalid links.'); } }}><Link2 />Create share link</Button>
        {result && <div className="flex gap-2 min-w-0"><input aria-label="Album share link" readOnly value={result} className="min-w-0 flex-1 rounded-md border border-input bg-secondary px-3 text-sm" /><Button variant="outline" aria-label="Copy album share link" title="Copy link" onClick={async () => { try { await navigator.clipboard.writeText(result); setCopied(true); } catch { setError('Copy the link from the box above.'); } }}>{copied ? <Check /> : <Copy />}</Button></div>}
      </>}
      {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">Share only music you have permission to distribute. Anyone with the link can download it. Pixeldrain may expire files or require a download check.</p>
    </DialogContent>
  </Dialog>;
}
