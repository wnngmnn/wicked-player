import { useEffect, useRef, useState } from 'react';
import { Copy, Check, Music, Share2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { prepareAlbum, buildVolume, uploadVolume, automaticShareUrl, sharingAction, type ShareAlbum } from './album-sharing';

import { useSharingAuth, sharingAccessToken } from './sharing/SharingAuth';
import { lovable } from '@/integrations/lovable';

export default function AlbumSharePanel({ album, load, onClose }: { album: ShareAlbum; load: (index: number) => Promise<Blob>; onClose: () => void }) {
  const { user, ready } = useSharingAuth();
  const started = useRef(false);
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
    let transfer: string | null = null, access = '';
    let completed = false;
    try {
      access = await sharingAccessToken();
      const prepared = await prepareAlbum(album, load, setStatus);
      c.signal.throwIfAborted();
      await sharingAction('begin', prepared.manifest, access, c.signal);
      transfer = prepared.manifest.id;
      const n = prepared.manifest.parts.length;
      for (let i = 0; i < n; i++) {
        c.signal.throwIfAborted();
        setStatus(n > 1 ? `Uploading part ${i + 1} of ${n}…` : 'Uploading album…');
        const blob = await buildVolume(prepared, i);
        await uploadVolume(blob, prepared.manifest.id, i, access, c.signal);
        setPct(Math.round(((i + 1) / n) * 100));
      }
      await sharingAction('finish', { id: prepared.manifest.id }, access, c.signal);
      completed = true;
      const url = automaticShareUrl(prepared.manifest.id); setResult(url);
      try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* user can copy manually */ }
    } catch (e) { setError(c.signal.aborted ? 'Sharing cancelled.' : e instanceof Error ? e.message : 'Album sharing failed.'); }
    finally { if (transfer && !completed) { try { await sharingAction('cancel', { id: transfer }, access); } catch { /* remaining copies stay inaccessible */ } } setBusy(false); setStatus(''); }
  };
  useEffect(() => { if (ready && user && !started.current) { started.current = true; void share(); } }, [ready, user]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => ctrl.current?.abort(), []);
  const signIn = async (provider: 'google') => {
    setError('');
    if (/^#\/project\/[A-Za-z0-9_-]+$/.test(location.hash)) sessionStorage.setItem('wicked_share_return', location.hash);
    const result = await lovable.auth.signInWithOAuth(provider, { redirect_uri: location.origin });
    if (result.error) setError(result.error.message);
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-lg bg-background text-foreground">
      <DialogHeader><DialogTitle>Share album</DialogTitle><DialogDescription>{album.name} · {album.artist || 'Unknown artist'}</DialogDescription></DialogHeader>
      <div className="flex gap-4 items-center">
        {album.coverDataUrl ? <img src={album.coverDataUrl} alt="" className="size-20 object-cover rounded-md" /> : <Music className="size-16 text-muted-foreground" />}
        <div><p className="font-semibold">{album.tracks.length} songs</p><p className="text-sm text-muted-foreground mt-1">Original quality · Cover and lyrics included</p></div>
      </div>
      {ready && !user && <div className="space-y-2"><p className="text-sm text-muted-foreground">Sign in to share. Your music stays on your computer.</p>
        <Button variant="outline" className="w-full" onClick={() => signIn('google')}><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/><path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"/></svg>Continue with Google</Button></div>}
      {user && !result && !busy && <Button disabled={!album.tracks.length} onClick={share}><Share2 />Share</Button>}
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
