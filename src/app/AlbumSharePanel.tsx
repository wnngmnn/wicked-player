import { useRef, useState } from 'react';
import { Copy, Check, Music, Share2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { prepareAlbum, buildVolume, uploadVolume, shareUrl, type ShareAlbum } from './album-sharing';

export default function AlbumSharePanel({ album, load, onClose }: { album: ShareAlbum; load: (index: number) => Promise<Blob>; onClose: () => void }) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState('');
  const [copied, setCopied] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const share = async () => {
    const c = new AbortController(); ctrl.current = c;
    setBusy(true); setError(''); setPct(0);
    try {
      const prepared = await prepareAlbum(album, load, setStatus);
      const n = prepared.manifest.parts.length, ids: string[] = [];
      for (let i = 0; i < n; i++) {
        c.signal.throwIfAborted();
        setStatus(n > 1 ? `Uploading part ${i + 1} of ${n}…` : 'Uploading album…');
        const blob = await buildVolume(prepared, i);
        ids.push(await uploadVolume(blob, `wicked-${prepared.manifest.id}-part-${String(i + 1).padStart(3, '0')}-of-${n}.zip`, c.signal));
        setPct(Math.round(((i + 1) / n) * 100));
      }
      const url = shareUrl(ids); setResult(url);
      try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* user can copy manually */ }
    } catch (e) { setError(c.signal.aborted ? 'Sharing cancelled.' : e instanceof Error ? e.message : 'Album sharing failed.'); }
    finally { setBusy(false); setStatus(''); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-lg bg-background text-foreground">
      <DialogHeader><DialogTitle>Share album</DialogTitle><DialogDescription>{album.name} · {album.artist || 'Unknown artist'}</DialogDescription></DialogHeader>
      <div className="flex gap-4 items-center">
        {album.coverDataUrl ? <img src={album.coverDataUrl} alt="" className="size-20 object-cover rounded-md" /> : <Music className="size-16 text-muted-foreground" />}
        <div><p className="font-semibold">{album.tracks.length} songs</p><p className="text-sm text-muted-foreground mt-1">Original quality · Cover and lyrics included</p></div>
      </div>
      {!result && !busy && <Button disabled={!album.tracks.length} onClick={share}><Share2 />Share</Button>}
      {busy && <div className="space-y-2">
        <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${Math.max(pct, 4)}%` }} /></div>
        <div className="flex items-center justify-between"><p role="status" className="text-sm text-muted-foreground">{status}</p><Button variant="ghost" size="icon" aria-label="Cancel sharing" onClick={() => ctrl.current?.abort()}><X /></Button></div>
      </div>}
      {result && <div className="space-y-2"><p className="text-sm">{copied ? 'Link copied — send it to anyone.' : 'Your share link:'}</p>
        <div className="flex gap-2 min-w-0"><input aria-label="Album share link" readOnly value={result} className="min-w-0 flex-1 rounded-md border border-input bg-secondary px-3 text-sm" /><Button variant="outline" aria-label="Copy link" onClick={async () => { try { await navigator.clipboard.writeText(result); setCopied(true); } catch { setError('Copy the link from the box.'); } }}>{copied ? <Check /> : <Copy />}</Button></div></div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">Anyone with the link can download this album. Only share music you're allowed to.</p>
    </DialogContent>
  </Dialog>;
}
