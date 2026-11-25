import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

export async function verifiedSharingUser(request: Request): Promise<string | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (token.split('.').length !== 3) return null;
  const url = process.env['SUPABASE_URL'], key = process.env['SUPABASE_PUBLISHABLE_KEY'];
  if (!url || !key) return null;
  const client = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: header } } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous) return null;
  return data.user.id;
}

export function boundedZipStream(body: ReadableStream<Uint8Array>, maximum: number, expected: number | null): ReadableStream<Uint8Array> {
  let size = 0; const prefix: number[] = [];
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maximum) throw new Error('Album part exceeds upload limit.');
      for (let i = 0; i < chunk.length && prefix.length < 4; i++) { const b = chunk[i]; if (b !== undefined) prefix.push(b); }
      if (prefix.length === 4 && (prefix[0] !== 0x50 || prefix[1] !== 0x4b || prefix[2] !== 3 || prefix[3] !== 4)) throw new Error('Invalid ZIP file.');
      controller.enqueue(chunk);
    },
    flush() { if (size < 22 || (expected !== null && size !== expected)) throw new Error('Incomplete album part.'); },
  }));
}
