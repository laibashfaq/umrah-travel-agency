import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_ACCESS } from '@/lib/auth/config';
import { authApi, clearSessionCookies } from '@/lib/auth/server';

/** Same-origin check for state-changing form posts (defence in depth on top of SameSite=Lax cookies). */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin) return new URL(origin).host === request.nextUrl.host;
  return request.headers.get('sec-fetch-site') !== 'cross-site';
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return new NextResponse('Forbidden', { status: 403 });
  const token = (await cookies()).get(COOKIE_ACCESS)?.value;
  // Revoke the login on the server; ignore failures (an expired token means it is already unusable).
  if (token) await authApi('/auth/logout', { method: 'POST', token });
  await clearSessionCookies();
  return NextResponse.redirect(new URL('/', request.url), 303);
}

export const dynamic = 'force-dynamic';
