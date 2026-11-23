import { destinationFor, homeFor, safeNextPath } from './config';

describe('safeNextPath (open-redirect protection)', () => {
  it('allows ordinary same-site paths with query strings', () => {
    expect(safeNextPath('/account/bookings?tab=paid', '/account')).toBe('/account/bookings?tab=paid');
    expect(safeNextPath('/admin/security', '/admin')).toBe('/admin/security');
  });

  it.each([
    'https://evil.example/phish',
    'http://evil.example',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'account',
    '',
    '/path\nwith-newline',
    '/path\u0000null',
  ])('rejects %j', (bad) => {
    expect(safeNextPath(bad, '/fallback')).toBe('/fallback');
  });

  it('rejects missing values, oversized values and bounces into the auth pages', () => {
    expect(safeNextPath(undefined, '/x')).toBe('/x');
    expect(safeNextPath(null, '/x')).toBe('/x');
    expect(safeNextPath('/' + 'a'.repeat(600), '/x')).toBe('/x');
    for (const p of ['/login', '/login?next=/admin', '/register', '/auth/refresh', '/forgot-password', '/reset-password?token=abc', '/verify-email']) {
      expect(safeNextPath(p, '/x')).toBe('/x');
    }
    // Similar-looking but legitimate paths are fine.
    expect(safeNextPath('/loginhelp', '/x')).toBe('/loginhelp');
  });
});

describe('destinationFor', () => {
  it('keeps each kind of user inside their own area', () => {
    expect(destinationFor('CUSTOMER', '/account/bookings')).toBe('/account/bookings');
    expect(destinationFor('STAFF', '/admin/security')).toBe('/admin/security');
    expect(destinationFor('CUSTOMER', '/admin/security')).toBe('/account');
    expect(destinationFor('STAFF', '/account')).toBe('/admin');
    expect(destinationFor('CUSTOMER', '/packages')).toBe('/account');
    expect(destinationFor('STAFF', undefined)).toBe('/admin');
    expect(destinationFor('CUSTOMER', 'https://evil.example')).toBe('/account');
    expect(destinationFor('CUSTOMER', '/accountant')).toBe('/account');
  });
  it('maps kinds to their home', () => {
    expect(homeFor('CUSTOMER')).toBe('/account');
    expect(homeFor('STAFF')).toBe('/admin');
  });
});
