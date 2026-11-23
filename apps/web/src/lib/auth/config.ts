/** Cookie names and shared helpers for authentication. Safe to import from client and server code. */

/** Short-lived access token (httpOnly). */
export const COOKIE_ACCESS = 'um_at';
/** Rotating refresh token (httpOnly). */
export const COOKIE_REFRESH = 'um_rt';
/** Multi-step sign-in state (2FA challenge / setup token), httpOnly and short-lived. */
export const COOKIE_FLOW = 'um_flow';
/** One-time backup codes handed to the "done" page after 2FA enrolment (httpOnly, short-lived, path-scoped). */
export const COOKIE_CODES = 'um_codes';
export const CODES_PATH = '/login/two-factor/done';

/** Non-secret hint ("customer" | "staff") so public pages can show "My account" without any server round-trip. */
export const COOKIE_KIND = 'um_kind';

export const ACCOUNT_HOME = '/account';
export const ADMIN_HOME = '/admin';

export const homeFor = (kind: 'CUSTOMER' | 'STAFF'): string => (kind === 'STAFF' ? ADMIN_HOME : ACCOUNT_HOME);

/**
 * Only same-site relative paths may be used as a post-login destination. Anything else (absolute URLs,
 * protocol-relative `//host`, backslash tricks, control characters) falls back to the default, which prevents
 * open-redirect phishing via `?next=`.
 */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
  if (!next || typeof next !== 'string') return fallback;
  if (next.length > 500 || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const url = new URL(next, 'http://placeholder.invalid');
    if (url.origin !== 'http://placeholder.invalid') return fallback;
  } catch {
    return fallback;
  }
  // Never bounce back into the auth pages themselves.
  if (/^\/(login|register|auth|forgot-password|reset-password|verify-email)(\/|\?|$)/.test(next)) return fallback;
  return next;
}

/** Customers may only land in /account, staff only in /admin. */
export function destinationFor(kind: 'CUSTOMER' | 'STAFF', next: string | null | undefined): string {
  const home = homeFor(kind);
  const safe = safeNextPath(next, home);
  const area = kind === 'STAFF' ? ADMIN_HOME : ACCOUNT_HOME;
  return safe === area || safe.startsWith(`${area}/`) || safe.startsWith(`${area}?`) ? safe : home;
}

export interface FlowState {
  kind: 'challenge' | 'setup';
  token: string;
  next?: string;
}
