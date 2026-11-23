import { base32Decode, base32Encode, otpauthUri, timeStep, totpAt, verifyTotp } from './totp';

// RFC 6238 Appendix B: SHA-1, shared secret "12345678901234567890", 8 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC test vector at T=%i', (seconds, expected) => {
    expect(totpAt(RFC_SECRET, seconds * 1000, 8)).toBe(expected);
  });

  it('round-trips base32 and tolerates spaces/case/padding', () => {
    const buf = Buffer.from('hello authenticator');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(base32Decode(base32Encode(buf).toLowerCase().replace(/(.{4})/g, '$1 ')).equals(buf)).toBe(true);
    expect(() => base32Decode('NOT*BASE32')).toThrow();
  });

  const now = 1_700_000_000_000;
  const code = (offsetSteps: number) => totpAt(RFC_SECRET, now + offsetSteps * 30_000);

  it('accepts the current code and one step of clock drift either way', () => {
    expect(verifyTotp(RFC_SECRET, code(0), now, null)).toBe(timeStep(now));
    expect(verifyTotp(RFC_SECRET, code(-1), now, null)).toBe(timeStep(now) - 1);
    expect(verifyTotp(RFC_SECRET, code(1), now, null)).toBe(timeStep(now) + 1);
  });

  it('rejects codes outside the window, malformed codes and wrong secrets', () => {
    expect(verifyTotp(RFC_SECRET, code(3), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code(-3), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now, null)).toBeNull();
    expect(verifyTotp(base32Encode(Buffer.from('another secret!!!!!')), code(0), now, null)).toBeNull();
  });

  it('blocks replay: a step at or below the last accepted one is refused', () => {
    const step = timeStep(now);
    expect(verifyTotp(RFC_SECRET, code(0), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code(-1), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code(1), now, step)).toBe(step + 1);
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'staff@example.com', 'Umrah Travel');
    expect(uri.startsWith('otpauth://totp/Umrah%20Travel:staff%40example.com?')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});
