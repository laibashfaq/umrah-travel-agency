import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AuthTokens, PermissionKey, SessionUser } from '@umrah/shared';
import { API_BASE_URL } from '@/lib/api';
import { CODES_PATH, COOKIE_ACCESS, COOKIE_CODES, COOKIE_FLOW, COOKIE_KIND, COOKIE_REFRESH, homeFor, type FlowState } from './config';

/* ------------------------------------------------------------------ */
/* Talking to the API                                                  */
/* ------------------------------------------------------------------ */

export interface ApiFailure {
  message: string;
  code?: string;
  errors?: { field: string; message: string }[];
}
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiFailure };

/**
 * The visitor's IP, forwarded so the API can rate-limit per person rather than per web server.
 * `WEB_TRUSTED_PROXY_HOPS` is the number of proxies/load balancers between the internet and this server;
 * the address those proxies appended is the real client (earlier entries can be spoofed by the client).
 */
async function visitorIp(): Promise<string> {
  const hops = Number(process.env.WEB_TRUSTED_PROXY_HOPS ?? 0);
  if (!hops) return '127.0.0.1';
  const xff = (await headers()).get('x-forwarded-for');
  const parts = xff?.split(',').map((p) => p.trim()).filter(Boolean) ?? [];
  return parts[Math.max(0, parts.length - hops)] ?? '127.0.0.1';
}

export async function authApi<T = unknown>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; token?: string } = {},
): Promise<ApiResult<T>> {
  const h = await headers();
  const requestHeaders: Record<string, string> = {
    Accept: 'application/json',
    'x-client-ip': await visitorIp(),
    'user-agent': h.get('user-agent') ?? 'unknown',
  };
  if (process.env.INTERNAL_API_KEY) requestHeaders['x-internal-key'] = process.env.INTERNAL_API_KEY;
  if (opts.body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (opts.token) requestHeaders.Authorization = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { method: opts.method ?? 'GET', headers: requestHeaders, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store' });
  } catch {
    return { ok: false, status: 503, error: { message: 'The service is temporarily unavailable. Please try again.', code: 'unavailable' } };
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const e = (json ?? {}) as Partial<ApiFailure>;
  return { ok: false, status: res.status, error: { message: e.message ?? 'Something went wrong.', code: e.code, errors: e.errors } };
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

const secure = process.env.NODE_ENV === 'production';
const seconds = (iso: string, skew = 0) => Math.max(1, Math.floor((Date.parse(iso) - Date.now()) / 1000) - skew);

export async function setSessionCookies(tokens: AuthTokens, kind: 'CUSTOMER' | 'STAFF'): Promise<void> {
  const jar = await cookies();
  const base = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  // The access cookie expires a little before the JWT so a stale token is never sent.
  jar.set(COOKIE_ACCESS, tokens.accessToken, { ...base, maxAge: seconds(tokens.accessExpiresAt, 15) });
  jar.set(COOKIE_REFRESH, tokens.refreshToken, { ...base, maxAge: seconds(tokens.refreshExpiresAt) });
  jar.set(COOKIE_KIND, kind === 'STAFF' ? 'staff' : 'customer', { httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge: seconds(tokens.refreshExpiresAt) });
  jar.delete(COOKIE_FLOW);
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  for (const name of [COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_KIND, COOKIE_FLOW]) jar.delete(name);
}

export async function setFlowCookie(state: FlowState): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_FLOW, Buffer.from(JSON.stringify(state)).toString('base64url'), { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: state.kind === 'setup' ? 900 : 300 });
}

export async function readFlow(expected: FlowState['kind']): Promise<FlowState | null> {
  const raw = (await cookies()).get(COOKIE_FLOW)?.value;
  if (!raw) return null;
  try {
    const state = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as FlowState;
    return state.kind === expected && typeof state.token === 'string' ? state : null;
  } catch {
    return null;
  }
}

export async function clearFlowCookie(): Promise<void> {
  (await cookies()).delete(COOKIE_FLOW);
}

/** Stores the one-time backup codes for the confirmation page. Scoped to that path and expires in 5 minutes. */
export async function setBackupCodesCookie(codes: string[], continueTo: string): Promise<void> {
  (await cookies()).set(COOKIE_CODES, Buffer.from(JSON.stringify({ codes, continueTo })).toString('base64url'), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: CODES_PATH,
    maxAge: 300,
  });
}

export async function readBackupCodes(): Promise<{ codes: string[]; continueTo: string } | null> {
  const raw = (await cookies()).get(COOKIE_CODES)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { codes?: unknown; continueTo?: unknown };
    if (!Array.isArray(v.codes) || typeof v.continueTo !== 'string') return null;
    return { codes: v.codes.filter((c): c is string => typeof c === 'string'), continueTo: v.continueTo };
  } catch {
    return null;
  }
}

export async function clearBackupCodesCookie(): Promise<void> {
  (await cookies()).delete({ name: COOKIE_CODES, path: CODES_PATH });
}

/* ------------------------------------------------------------------ */
/* Refresh (single-flight)                                             */
/* ------------------------------------------------------------------ */

interface RefreshPayload {
  tokens: AuthTokens;
  user: SessionUser;
}
/** Requests currently being refreshed, keyed by refresh token. Entries are removed the moment they settle. */
const inflight = new Map<string, Promise<ApiResult<RefreshPayload>>>();

export type RefreshOutcome = 'ok' | 'race' | 'failed';

/**
 * Exchanges the refresh cookie for new tokens and stores them. Call from a Route Handler or Server Action:
 * cookies cannot be written while rendering.
 *
 * Only requests that are *simultaneously* in flight share one API call. A finished result is never reused: each
 * refresh token works exactly once, and handing the new session to a later caller presenting the same (now spent)
 * token would defeat refresh-token rotation and theft detection.
 */
export async function refreshSession(): Promise<RefreshOutcome> {
  const refreshToken = (await cookies()).get(COOKIE_REFRESH)?.value;
  if (!refreshToken) return 'failed';

  let pending = inflight.get(refreshToken);
  if (!pending) {
    pending = authApi<RefreshPayload>('/auth/refresh', { method: 'POST', body: { refreshToken } }).finally(() => inflight.delete(refreshToken));
    inflight.set(refreshToken, pending);
  }
  const result = await pending;
  if (!result.ok) {
    // `refresh_race`: a sibling request rotated this token moments ago. Keep the cookies; the caller may retry once
    // (the browser will then carry the sibling's new cookies).
    if (result.error.code === 'refresh_race') return 'race';
    await clearSessionCookies();
    return 'failed';
  }
  await setSessionCookies(result.data.tokens, result.data.user.type);
  return 'ok';
}

/* ------------------------------------------------------------------ */
/* Sessions for pages and actions                                      */
/* ------------------------------------------------------------------ */

export type SessionResult =
  | { status: 'ok'; user: SessionUser; accessToken: string }
  | { status: 'refresh' } // access token missing/expired but a refresh token exists
  | { status: 'anonymous' };

/** Reads the signed-in user (one API call per request). Never writes cookies. */
export const getSession = cache(async (): Promise<SessionResult> => {
  const jar = await cookies();
  const accessToken = jar.get(COOKIE_ACCESS)?.value;
  if (accessToken) {
    const me = await authApi<SessionUser>('/auth/me', { token: accessToken });
    if (me.ok) return { status: 'ok', user: me.data, accessToken };
  }
  return jar.get(COOKIE_REFRESH)?.value ? { status: 'refresh' } : { status: 'anonymous' };
});

async function currentPath(): Promise<string> {
  return (await headers()).get('x-pathname') ?? '/';
}

/** Server-side authorisation gate for layouts and pages (the proxy only does an early, optimistic redirect). */
export async function requireUser(kind: 'CUSTOMER' | 'STAFF'): Promise<{ user: SessionUser; accessToken: string }> {
  const session = await getSession();
  const path = encodeURIComponent(await currentPath());
  if (session.status === 'refresh') redirect(`/auth/refresh?next=${path}`);
  if (session.status === 'anonymous') redirect(`/login?next=${path}`);
  if (session.user.type !== kind) redirect(homeFor(session.user.type));
  return session;
}

/** For auth pages: bounce already-signed-in visitors to their area. */
export async function redirectIfSignedIn(): Promise<void> {
  const session = await getSession();
  if (session.status === 'ok') redirect(homeFor(session.user.type));
}

export const can = (user: SessionUser, permission: PermissionKey): boolean => user.permissions.includes(permission);

/** Calls the API as the signed-in user from a Server Action, refreshing once if the access token just expired. */
export async function callAsUser<T = unknown>(path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}): Promise<ApiResult<T>> {
  const attempt = async () => {
    const token = (await cookies()).get(COOKIE_ACCESS)?.value;
    if (!token) return { ok: false, status: 401, error: { message: 'Please sign in again.', code: 'unauthenticated' } } as ApiResult<T>;
    return authApi<T>(path, { ...opts, token });
  };
  let result = await attempt();
  if (!result.ok && result.status === 401 && (await refreshSession()) === 'ok') result = await attempt();
  return result;
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

async function fileHeaders(token: string): Promise<Record<string, string>> {
  const h = await headers();
  const out: Record<string, string> = { Authorization: `Bearer ${token}`, 'x-client-ip': await visitorIp(), 'user-agent': h.get('user-agent') ?? 'unknown' };
  if (process.env.INTERNAL_API_KEY) out['x-internal-key'] = process.env.INTERNAL_API_KEY;
  return out;
}

/** Sends a file to the API as the raw request body (the API reads its type from the bytes, not from the browser). */
export async function uploadAsUser<T = unknown>(path: string, bytes: ArrayBuffer): Promise<ApiResult<T>> {
  const token = (await cookies()).get(COOKIE_ACCESS)?.value;
  if (!token) return { ok: false, status: 401, error: { message: 'Please sign in again.', code: 'unauthenticated' } };
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { method: 'POST', headers: { ...(await fileHeaders(token)), Accept: 'application/json', 'Content-Type': 'application/octet-stream' }, body: bytes, cache: 'no-store' });
  } catch {
    return { ok: false, status: 503, error: { message: 'The service is temporarily unavailable. Please try again.', code: 'unavailable' } };
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const e = (json ?? {}) as Partial<ApiFailure>;
  return { ok: false, status: res.status, error: { message: e.message ?? (res.status === 413 ? 'That file is too large.' : 'Something went wrong.'), code: e.code, errors: e.errors } };
}

/** Fetches a private file from the API for the signed-in user. Null when not signed in. */
export async function fetchFileAsUser(path: string): Promise<Response | null> {
  const token = (await cookies()).get(COOKIE_ACCESS)?.value;
  if (!token) return null;
  return fetch(`${API_BASE_URL}${path}`, { headers: await fileHeaders(token), cache: 'no-store' });
}
