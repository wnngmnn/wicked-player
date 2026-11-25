/** Populated once the builder connects the shared Pixeldrain account. */
export function fileHostIsConfigured(): boolean { return false; }
export async function fileHostRequest(_path: string, _init: RequestInit): Promise<Response> {
  return Response.json({ error: 'The shared file-host account is not connected yet.' }, { status: 503 });
}
