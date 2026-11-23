import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_ACCESS, COOKIE_REFRESH } from '@/lib/auth/config';

/**
 * Optimistic gate for the portals: visitors with no session cookies are sent to sign in before any page renders.
 * This is only a convenience. Real authorisation happens in the API and in `requireUser()` on the server.
 * It also tells server components which path was requested (used for `?next=` after sign-in).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has(COOKIE_ACCESS) || request.cookies.has(COOKIE_REFRESH);
  if (!hasSession) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', `${pathname}${search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = { matcher: ['/account/:path*', '/admin/:path*'] };
