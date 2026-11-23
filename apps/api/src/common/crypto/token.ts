import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque, URL-safe random token (default 256 bits). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Fast hash for high-entropy secrets (email/reset tokens, backup codes). Never use for passwords. */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Keyed hash so a database leak alone cannot be used to verify guessed refresh tokens. */
export const hmacSha256 = (key: string, value: string): string => createHmac('sha256', key).update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** '15m' | '2h' | '7d' | '900s' | '900' -> seconds. */
export function durationToSeconds(value: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  if (!m) throw new Error(`Invalid duration: ${value}`);
  const n = Number(m[1]);
  return n * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd']);
}
