const GATEWAY_URL = 'https://connector-gateway.lovable.dev/udc_pixeldrain';
export function fileHostIsConfigured(): boolean {
  return Boolean(process.env['LOVABLE_API_KEY'] && process.env['UDC_PIXELDRAIN_API_KEY']);
}
export async function fileHostRequest(path: string, init: RequestInit): Promise<Response> {
  const lovableKey = process.env['LOVABLE_API_KEY'], connectionKey = process.env['UDC_PIXELDRAIN_API_KEY'];
  if (!lovableKey || !connectionKey) return Response.json({ error: 'The shared file-host account is not connected yet.' }, { status: 503 });
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${lovableKey}`);
  headers.set('X-Connection-Api-Key', connectionKey);
  return fetch(`${GATEWAY_URL}${path}`, { ...init, headers, ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
}
