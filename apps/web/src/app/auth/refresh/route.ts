import { NextResponse, type NextRequest } from 'next/server';
import { safeNextPath } from '@/lib/auth/config';
import { refreshSession } from '@/lib/auth/server';

/**
 * Silent token refresh. Server components cannot write cookies, so when an access token has expired they redirect
 * here; we rotate the refresh token, set fresh cookies, and send the visitor straight back to the page they wanted.
 */
export async function GET(request: NextRequest) {
  const next = safeNextPath(request.nextUrl.searchParams.get('next'), '/account');
  // Refuse cross-site triggers; this must only run as part of our own navigation.
  if (request.headers.get('sec-fetch-site') === 'cross-site') return NextResponse.redirect(new URL('/login', request.url), 303);

  const outcome = await refreshSession();
  if (outcome === 'ok') return NextResponse.redirect(new URL(next, request.url), 303);
  // A parallel request rotated the token an instant ago: try once more so the browser can bring its new cookies.
  if (outcome === 'race' && request.nextUrl.searchParams.get('r') !== '1') {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = new URL('/auth/refresh', request.url);
    again.searchParams.set('next', next);
    again.searchParams.set('r', '1');
    return NextResponse.redirect(again, 303);
  }
  const login = new URL('/login', request.url);
  login.searchParams.set('next', next);
  return NextResponse.redirect(login, 303);
}

export const dynamic = 'force-dynamic';
