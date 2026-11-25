import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { validateManifest } from '@/app/album-sharing';

const uuid = z.string().uuid();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const Route = createFileRoute('/api/public/share-upload')({
  server: { handlers: {
    POST: async ({ request }) => {
      const { verifiedSharingUser } = await import('@/app/sharing/security.server');
      const userId = await verifiedSharingUser(request);
      if (!userId) return json({ error: 'Sign in to share an album.' }, 401);
      const { fileHostIsConfigured } = await import('@/app/sharing/file-host.server');
      if (!fileHostIsConfigured()) return json({ error: 'Automatic sharing is waiting for the app owner to connect the file-host account.' }, 503);
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const action = new URL(request.url).searchParams.get('action');
      const length = Number(request.headers.get('content-length'));
      if (length > 1100000) return json({ error: 'Album information is too large.' }, 413);
      let input: unknown; try { input = await request.json(); } catch { return json({ error: 'Invalid album request.' }, 400); }
      if (action === 'begin') {
        let manifest; try { manifest = validateManifest(input); } catch { return json({ error: 'Invalid album information.' }, 400); }
        const { error } = await supabaseAdmin.from('album_shares').insert({ id: manifest.id, user_id: userId, manifest });
        if (error) return json({ error: 'Could not start sharing. Try again.' }, 409);
        return json({ id: manifest.id });
      }
      const parsed = z.object({ id: uuid }).safeParse(input);
      if (!parsed.success) return json({ error: 'Invalid share request.' }, 400);
      const { data: share } = await supabaseAdmin.from('album_shares').select('id,manifest,status').eq('id', parsed.data.id).eq('user_id', userId).maybeSingle();
      if (!share) return json({ error: 'Share not found.' }, 404);
      if (action === 'finish') {
        const manifest = validateManifest(share.manifest);
        const { data: parts } = await supabaseAdmin.from('album_share_parts').select('part_index,file_id,status').eq('share_id', share.id).order('part_index');
        if (parts?.length !== manifest.parts.length || parts.some((p, i) => p.part_index !== i || p.status !== 'complete' || !p.file_id)) return json({ error: 'The album has not finished uploading.' }, 409);
        const { error } = await supabaseAdmin.from('album_shares').update({ status: 'complete' }).eq('id', share.id).eq('user_id', userId).eq('status','pending');
        return error ? json({ error: 'Could not finish sharing.' }, 500) : json({ id: share.id });
      }
      if (action === 'cancel') {
        const { fileHostRequest } = await import('@/app/sharing/file-host.server');
        const { data: parts } = await supabaseAdmin.from('album_share_parts').select('file_id').eq('share_id', share.id);
        await supabaseAdmin.from('album_shares').update({ status: 'cancelled' }).eq('id', share.id).eq('user_id', userId);
        for (const part of parts ?? []) if (part.file_id) { try { await fileHostRequest(`/file/${part.file_id}`, { method: 'DELETE' }); } catch { /* host cleanup can be retried */ } }
        return json({ cancelled: true });
      }
      return json({ error: 'Unknown sharing action.' }, 400);
    },
    PUT: async ({ request }) => {
      const { verifiedSharingUser, boundedZipStream } = await import('@/app/sharing/security.server');
      const userId = await verifiedSharingUser(request);
      if (!userId) return json({ error: 'Sign in to share an album.' }, 401);
      const { fileHostIsConfigured, fileHostRequest } = await import('@/app/sharing/file-host.server');
      if (!fileHostIsConfigured()) return json({ error: 'The shared file-host account is not connected yet.' }, 503);
      const url = new URL(request.url), id = uuid.safeParse(url.searchParams.get('share'));
      const part = z.coerce.number().int().min(0).max(199).safeParse(url.searchParams.get('part'));
      if (!id.success || !part.success || !request.body) return json({ error: 'Invalid album part.' }, 400);
      const rawLength = request.headers.get('content-length'), length = rawLength === null ? null : Number(rawLength);
      const MAX = 95 * 1024 * 1024;
      if (length !== null && (!Number.isSafeInteger(length) || length < 22 || length > MAX)) return json({ error: 'Album part is too large.' }, 413);
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const { data: share } = await supabaseAdmin.from('album_shares').select('id,manifest,status').eq('id', id.data).eq('user_id', userId).maybeSingle();
      if (!share || share.status !== 'pending') return json({ error: 'This share is not accepting uploads.' }, 409);
      const manifest = validateManifest(share.manifest);
      if (!manifest.parts[part.data]) return json({ error: 'Unknown album part.' }, 400);
      const { error: reservation } = await supabaseAdmin.from('album_share_parts').insert({ share_id: share.id, part_index: part.data });
      if (reservation) return json({ error: 'This part is already uploading. Restart sharing if it was interrupted.' }, 409);
      let fileId: string | null = null;
      try {
        const name = `wicked-${share.id}-part-${String(part.data + 1).padStart(3, '0')}-of-${manifest.parts.length}.zip`;
        const response = await fileHostRequest(`/file/${name}`, { method: 'PUT', body: boundedZipStream(request.body, MAX, length), signal: request.signal, ...(length !== null ? { headers: { 'Content-Length': String(length) } } : {}) });
        if (!response.ok) { const text = await response.text(); console.error('File-host upload failed', response.status, text.slice(0, 500)); throw new Error(`Pixeldrain rejected this upload (${response.status}). Check the shared account's storage and upload permissions.`); }
        const payload = z.object({ id: z.string().regex(/^[A-Za-z0-9]{8}$/) }).parse(await response.json()); fileId = payload.id;
        const { data: fresh } = await supabaseAdmin.from('album_shares').select('status').eq('id', share.id).maybeSingle();
        if (fresh?.status !== 'pending') throw new Error('Sharing was cancelled.');
        const { error } = await supabaseAdmin.from('album_share_parts').update({ status: 'complete', file_id: fileId }).eq('share_id', share.id).eq('part_index', part.data);
        if (error) throw new Error('Could not save the uploaded part.');
        return json({ id: fileId });
      } catch (e) {
        if (fileId) { try { await fileHostRequest(`/file/${fileId}`, { method: 'DELETE' }); } catch { /* best effort */ } }
        await supabaseAdmin.from('album_share_parts').delete().eq('share_id', share.id).eq('part_index', part.data);
        return json({ error: e instanceof Error ? e.message : 'Album upload failed.' }, 502);
      }
    },
  } },
});
