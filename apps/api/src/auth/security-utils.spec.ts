import { checkPassword, registerSchema, resetPasswordSchema } from '@umrah/shared';
import { redact, REDACTED } from '../audit/redact';
import { durationToSeconds, hmacSha256, randomToken, safeEqual, sha256 } from '../common/crypto/token';
import { textToHtml } from '../mail/mailer.service';

describe('password policy', () => {
  it('accepts a long, uncommon password', () => {
    expect(checkPassword('correct horse battery staple')).toEqual([]);
  });
  it('rejects short, common, repetitive and identity-containing passwords', () => {
    expect(checkPassword('Short1!')).toContain('too_short');
    expect(checkPassword('password1234')).toContain('too_common');
    expect(checkPassword('aaaaaaaaaaaaaa')).toContain('repetitive');
    expect(checkPassword('abababababababab')).toContain('repetitive');
    expect(checkPassword('muhammad.ali.2027', ['muhammad@example.com'])).toContain('contains_identity');
  });
  it('is enforced by the shared register and reset schemas', () => {
    const base = { firstName: 'A', lastName: 'B', email: 'a@example.com', acceptTerms: true as const };
    expect(registerSchema.safeParse({ ...base, password: 'password1234' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, password: 'a much longer passphrase' }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, password: 'a much longer passphrase', acceptTerms: false }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: 'x'.repeat(30), password: 'tiny' }).success).toBe(false);
  });
  it('normalises the email on registration', () => {
    const r = registerSchema.parse({ firstName: 'A', lastName: 'B', email: '  A@Example.COM ', password: 'a much longer passphrase', acceptTerms: true });
    expect(r.email).toBe('a@example.com');
  });
});

describe('audit redaction', () => {
  it('masks secrets by key name at any depth and keeps the rest', () => {
    const out = redact({
      email: 'a@example.com',
      password: 'hunter2',
      nested: { refreshToken: 'abc', passportNumber: 'AB123', cnic: '35202', ok: 1 },
      list: [{ authorization: 'Bearer x', name: 'n' }],
    }) as Record<string, unknown>;
    expect(out.email).toBe('a@example.com');
    expect(out.password).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).refreshToken).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).passportNumber).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).cnic).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('Bearer x');
  });
  it('serialises dates, truncates huge values and stops at a depth limit', () => {
    expect(redact({ at: new Date('2026-01-01T00:00:00Z') })).toEqual({ at: '2026-01-01T00:00:00.000Z' });
    expect((redact({ big: 'x'.repeat(5000) }) as { big: string }).big.length).toBeLessThan(2100);
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(JSON.stringify(redact(deep))).toContain('[TRUNCATED]');
  });
});

describe('token utilities', () => {
  it('generates unguessable URL-safe tokens and stable hashes', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
    expect(sha256('x')).toBe(sha256('x'));
    expect(sha256('x')).toHaveLength(64);
    expect(hmacSha256('k1', 'x')).not.toBe(hmacSha256('k2', 'x'));
  });
  it('compares in constant time and parses durations', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(durationToSeconds('15m')).toBe(900);
    expect(durationToSeconds('2h')).toBe(7200);
    expect(durationToSeconds('7d')).toBe(604800);
    expect(durationToSeconds('90')).toBe(90);
    expect(() => durationToSeconds('soon')).toThrow();
  });
});

describe('email HTML', () => {
  it('escapes content and only links http(s) URLs', () => {
    const html = textToHtml('Hi <b>', 'Click https://example.com/a?x=1&y=2\n\n<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(html).toContain('Hi &lt;b&gt;');
  });
});
