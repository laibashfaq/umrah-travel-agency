import 'server-only';
import { NextResponse } from 'next/server';
import { fetchFileAsUser } from '@/lib/auth/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Streams a private document from the API to the signed-in person. The browser never talks to storage and never
 * gets a reusable link: authorisation and the download log happen in the API on every request.
 */
export async function proxyDocument(apiPath: (id: string) => string, id: string): Promise<Response> {
  if (!UUID.test(id)) return new NextResponse('Not found', { status: 404 });
  const res = await fetchFileAsUser(apiPath(id));
  if (!res) return new NextResponse('Please sign in again.', { status: 401 });
  if (!res.ok) return new NextResponse(res.status === 403 ? 'You do not have access to this file.' : 'Not found', { status: res.status === 403 ? 403 : 404 });
  const headers = new Headers();
  for (const name of ['content-type', 'content-disposition', 'content-length']) {
    const v = res.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new NextResponse(res.body, { status: 200, headers });
}
