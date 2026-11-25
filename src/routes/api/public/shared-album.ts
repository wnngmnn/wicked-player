import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { validateManifest } from '@/app/album-sharing';

export const Route = createFileRoute('/api/public/shared-album')({ server: { handlers: {
  GET: async ({ request }) => {
    const url = new URL(request.url), id = z.string().uuid().safeParse(url.searchParams.get('share'));
    if (!id.success) return Response.json({ error: 'Invalid album link.' }, { status: 400 });
    // The unguessable share ID grants access only to a deliberately completed share.
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: share } = await supabaseAdmin.from('album_shares').select('manifest').eq('id', id.data).eq('status', 'complete').maybeSingle();
    if (!share) return Response.json({ error: 'This album link is unavailable or has not finished uploading.' }, { status: 404 });
    const manifest = validateManifest(share.manifest);
    if (!url.searchParams.has('part')) return Response.json({ manifest }, { headers: { 'Cache-Control': 'no-store' } });
    const part = z.coerce.number().int().min(0).max(manifest.parts.length - 1).safeParse(url.searchParams.get('part'));
    if (!part.success) return Response.json({ error: 'Invalid album part.' }, { status: 400 });
    const { data: entry } = await supabaseAdmin.from('album_share_parts').select('file_id').eq('share_id', id.data).eq('part_index', part.data).eq('status', 'complete').maybeSingle();
    if (!entry?.file_id) return Response.json({ error: 'This album part is unavailable.' }, { status: 404 });
    const { fileHostRequest } = await import('@/app/sharing/file-host.server');
    const response = await fileHostRequest(`/file/${entry.file_id}`, { method: 'GET', signal: request.signal });
    if (!response.ok) return Response.json({ error: `Pixeldrain could not download this part (${response.status}). Try again later.` }, { status: 502 });
    return new Response(response.body, { headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  },
} } });
