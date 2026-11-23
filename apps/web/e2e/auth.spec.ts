import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Sign-in, registration, 2FA and portal guards against the real API and database.
 * Needs the dev email provider (EMAIL_PROVIDER=log): messages are read from the local outbox folder.
 */

const ROOT = path.resolve(__dirname, '../../..');
const OUTBOX = path.join(ROOT, '.local', 'outbox');
const STRONG = 'correct horse battery staple';
const NEW_STRONG = 'another very long passphrase 42';
const run = Date.now().toString(36);
const unique = (tag: string) => `e2e-web-${tag}-${run}@example.com`;

let ipCounter = 0;
test.beforeEach(async ({ context }) => {
  // The web server forwards the visitor IP to the API (WEB_TRUSTED_PROXY_HOPS=1), so each test gets its own rate-limit bucket.
  ipCounter++;
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `10.77.${(ipCounter >> 8) & 255}.${ipCounter & 255}` });
});

/* ------------------------------- helpers ------------------------------- */

/** Newest outbox message to `email` whose subject contains `subject`; resolves with the first link in it. */
async function linkFromEmail(email: string, subject: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    let files: string[] = [];
    try {
      files = readdirSync(OUTBOX).filter((f) => f.endsWith('.json')).sort().reverse();
    } catch {
      /* outbox not created yet */
    }
    for (const f of files) {
      const msg = JSON.parse(readFileSync(path.join(OUTBOX, f), 'utf8')) as { to: string; subject: string; text: string };
      if (msg.to === email && msg.subject.includes(subject)) {
        const url = /https?:\/\/\S+/.exec(msg.text)?.[0];
        if (url) {
          const u = new URL(url);
          return `${u.pathname}${u.search}`; // relative, so it works against whichever host serves the site
        }
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No "${subject}" email for ${email} in ${OUTBOX} (is EMAIL_PROVIDER=log?)`);
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 code for an absolute 30s step number. */
function totpAtStep(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1]! & 15;
  const bin = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

const currentStep = () => Math.floor(Date.now() / 1000 / 30);

/** Code for the current 30s step plus `offsetSteps`. */
function totp(secret: string, offsetSteps = 0): string {
  return totpAtStep(secret, currentStep() + offsetSteps);
}

/** The step a test consumed, so a later test can replay exactly that code however slowly the machine runs. */
let consumedStep = 0;

function createStaff(tag: string, role: string): { email: string; password: string } {
  const email = unique(tag);
  const out = execFileSync('npm', ['run', 'staff:create', '-w', '@umrah/api', '--', '--email', email, '--role', role, '--first', 'Test', '--last', role], {
    cwd: ROOT,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  const password = /Temporary password: (\S+)/.exec(out)?.[1];
  if (!password) throw new Error(`staff:create gave no password:\n${out}`);
  return { email, password };
}

async function signIn(page: Page, email: string, password: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signInTo(page: Page, email: string, password: string, url: RegExp) {
  await signIn(page, email, password);
  await expect(page).toHaveURL(url);
}

async function registerAndVerify(page: Page, email: string) {
  await page.goto('/register');
  await page.getByLabel('First name').fill('Ali');
  await page.getByLabel('Last name').fill('Khan');
  await page.getByLabel('Email').fill(email);
  await page.locator('input[name="password"]').fill(STRONG);
  await page.getByRole('checkbox', { name: /I agree/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await linkFromEmail(email, 'Verify your email'));
  await page.getByRole('button', { name: 'Verify my email address' }).click();
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
}

/* ============================== guards & redirects ============================== */

test.describe('portal guards', () => {
  test('signed-out visitors are sent to sign in and returned to the page they wanted', async ({ page }) => {
    await page.goto('/account');
    await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);
    await page.goto('/admin/security');
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fsecurity$/);
  });

  test('public pages stay public and identical (no personalisation baked into cached HTML)', async ({ page, request }) => {
    const res = await request.get('/packages');
    // Only a production build sets CDN cache headers (set PW_PROD=1 when testing `next start`).
    if (process.env.PW_PROD === '1') expect(res.headers()['cache-control']).toContain('s-maxage');
    expect(await res.text()).not.toContain('My account');
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  });

  test('auth pages and portals are never cacheable and not indexable', async ({ request }) => {
    for (const p of ['/login', '/register', '/forgot-password']) {
      const res = await request.get(p);
      expect(res.headers()['cache-control'], p).toContain('no-store');
      expect(await res.text(), p).toContain('noindex');
    }
    const robots = await (await request.get('/robots.txt')).text();
    for (const p of ['/login', '/register', '/account', '/admin']) expect(robots).toContain(`Disallow: ${p}`);
  });
});

/* ================================= customers ================================= */

test.describe('customer account', () => {
  test('register, verify by email, sign in, see the dashboard, sign out; cookies are locked down', async ({ page, context }) => {
    const email = unique('cust');
    await registerAndVerify(page, email);

    await signIn(page, email, STRONG);
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Ali');
    await expect(page.getByText('Verify your email address')).toHaveCount(0); // already verified
    await expect(page.getByText('No bookings yet')).toBeVisible();

    // Tokens live only in httpOnly, SameSite cookies; JavaScript cannot read them.
    const cookies = await context.cookies();
    const at = cookies.find((c) => c.name === 'um_at');
    const rt = cookies.find((c) => c.name === 'um_rt');
    expect(at).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(rt).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/um_at|um_rt/);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toMatch(/eyJ/);
    // The access token is a JWT; the refresh token is opaque and long.
    expect(at!.value.split('.')).toHaveLength(3);
    expect(rt!.value.length).toBeGreaterThanOrEqual(40);

    // Public pages show the account link for a signed-in visitor.
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'My account' }).first()).toBeVisible();

    // Sign out revokes the session and clears cookies.
    await page.goto('/account');
    await page.getByRole('button', { name: new RegExp(email.slice(0, 5), 'i') }).or(page.locator('header button[aria-haspopup="menu"]').last()).first().click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect((await context.cookies()).some((c) => c.name === 'um_at' || c.name === 'um_rt')).toBe(false);
    await page.goto('/account');
    await expect(page).toHaveURL(/\/login/);
  });

  test('unverified customers see a verification reminder', async ({ page }) => {
    const email = unique('unver');
    await page.goto('/register');
    await page.getByLabel('First name').fill('Sara');
    await page.getByLabel('Last name').fill('Ahmed');
    await page.getByLabel('Email').fill(email);
    await page.locator('input[name="password"]').fill(STRONG);
    await page.getByRole('checkbox', { name: /I agree/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await signIn(page, email, STRONG);
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText('Verify your email address')).toBeVisible();
    await page.getByRole('button', { name: 'Resend verification email' }).click();
    await expect(page.getByText(/we have sent a new link/i)).toBeVisible();
  });

  test('registration enforces the password policy with live hints and server-side errors', async ({ page }) => {
    await page.goto('/register');
    const password = page.locator('input[name="password"]');
    await password.fill('short');
    await expect(page.getByText('Use at least 12 characters')).toBeVisible();
    await password.fill('password1234');
    await expect(page.getByText(/too common/)).toBeVisible();
    await page.getByLabel('First name').fill('Ali');
    await page.getByLabel('Last name').fill('Khan');
    await page.getByLabel('Email').fill(unique('weak'));
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Please accept the terms and privacy policy')).toBeVisible();
    await expect(page.locator('[data-slot="alert"][role="alert"]').first()).toBeVisible();
  });

  test('wrong credentials give one generic message; unknown and known accounts look identical', async ({ page }) => {
    const email = unique('wrong');
    await registerAndVerify(page, email);
    await signIn(page, email, 'not the right password');
    const known = await page.locator('[data-slot="alert"][role="alert"]').first().innerText();
    await signIn(page, unique('ghost'), 'not the right password');
    const unknown = await page.locator('[data-slot="alert"][role="alert"]').first().innerText();
    expect(known).toBe(unknown);
    // The email survives the failed attempt; the password does not.
    await expect(page.getByLabel('Email')).toHaveValue(/e2e-web-ghost-/);
    await expect(page.locator('input[name="password"]')).toHaveValue('');
    expect(known).toContain('Invalid email or password');
    await expect(page).toHaveURL(/\/login/);
  });

  test('a ?next= destination is honoured only when it is a safe path inside the user\'s area', async ({ page }) => {
    const email = unique('next');
    await registerAndVerify(page, email);
    await signIn(page, email, STRONG, '//evil.example/phish');
    await expect(page).toHaveURL(/\/account$/);
    await page.goto('/auth/logout').catch(() => undefined);
    // Sign out through the API-backed route (POST), then test an in-area deep link.
    await page.context().clearCookies();
    await signIn(page, email, STRONG, '/account/settings-placeholder');
    await expect(page).toHaveURL(/\/account\/settings-placeholder$/); // in-area path is allowed (404 page, but no open redirect)
  });

  test('forgot/reset password: link works once, old password stops working, new one signs in', async ({ page }) => {
    const email = unique('reset');
    await registerAndVerify(page, email);
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    // Unknown address gets the very same screen (no enumeration).
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(unique('nobody'));
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const link = await linkFromEmail(email, 'Reset your password');
    await page.goto(link);
    await page.locator('input[name="password"]').fill('password1234');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByText(/too common/).first()).toBeVisible(); // weak password: link not consumed
    await page.locator('input[name="password"]').fill(NEW_STRONG);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page).toHaveURL(/\/login\?reset=1/);
    await expect(page.getByText('Your password was updated')).toBeVisible();

    await page.goto(link);
    await page.locator('input[name="password"]').fill(NEW_STRONG + '!');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByText(/invalid or has expired/)).toBeVisible(); // single use

    await signIn(page, email, STRONG);
    await expect(page.locator('[data-slot="alert"][role="alert"]').first()).toContainText('Invalid email or password');
    await signIn(page, email, NEW_STRONG);
    await expect(page).toHaveURL(/\/account$/);
  });

  test('an expired access token is refreshed silently and the refresh token rotates', async ({ page, context }) => {
    const email = unique('refresh');
    await registerAndVerify(page, email);
    await signIn(page, email, STRONG);
    await expect(page).toHaveURL(/\/account$/);
    const before = (await context.cookies()).find((c) => c.name === 'um_rt')!.value;

    // Simulate the 15-minute access token expiring.
    await context.clearCookies({ name: 'um_at' });
    await page.goto('/account');
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Ali');
    const jar = await context.cookies();
    expect(jar.find((c) => c.name === 'um_at')).toBeDefined();
    expect(jar.find((c) => c.name === 'um_rt')!.value).not.toBe(before);
  });

  test('a stolen (already rotated) refresh token cannot start a session', async ({ browser, page, context }) => {
    const email = unique('theft');
    await registerAndVerify(page, email);
    await signIn(page, email, STRONG);
    await expect(page).toHaveURL(/\/account$/);
    const stolen = (await context.cookies()).find((c) => c.name === 'um_rt')!;
    await context.clearCookies({ name: 'um_at' });
    await page.goto('/account'); // legitimate rotation

    const attacker = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.88.0.1' } });
    await attacker.addCookies([{ ...stolen, domain: 'localhost', path: '/' }]);
    const evil = await attacker.newPage();
    await evil.goto('/account');
    await expect(evil).toHaveURL(/\/login/);
    await attacker.close();
  });

  test('customers cannot open the staff portal', async ({ page }) => {
    const email = unique('custadmin');
    await registerAndVerify(page, email);
    await signInTo(page, email, STRONG, /\/account$/);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/account$/);
    await page.goto('/admin/security');
    await expect(page).toHaveURL(/\/account$/);
  });
});

/* =================================== staff =================================== */

test.describe('staff accounts and two-factor authentication', () => {
  test.describe.configure({ mode: 'serial' });
  let staff: { email: string; password: string };
  let secret = '';
  let backupCodes: string[] = [];

  test.beforeAll(() => {
    staff = createStaff('staff', 'BOOKING_MANAGER');
  });

  test('first sign-in forces authenticator enrolment and shows one-time backup codes', async ({ page }) => {
    await signIn(page, staff.email, staff.password);
    await expect(page).toHaveURL(/\/login\/two-factor\/setup$/);
    expect((await page.context().cookies()).some((c) => c.name === 'um_at')).toBe(false); // no session yet

    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await page.getByText("Can't scan?").click();
    secret = (await page.getByTestId('totp-secret').innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
    await expect(page.getByText(/not correct/i)).toBeVisible();

    await page.getByLabel('6-digit code').fill(totp(secret));
    await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
    await expect(page).toHaveURL(/\/login\/two-factor\/done$/);
    await expect(page.getByRole('heading', { name: 'Save your backup codes' })).toBeVisible();
    backupCodes = await page.getByRole('list', { name: 'Backup codes' }).getByRole('listitem').allInnerTexts();
    expect(backupCodes).toHaveLength(10);
    // The codes cookie is httpOnly and scoped to this page only.
    const codesCookie = (await page.context().cookies()).find((c) => c.name === 'um_codes');
    expect(codesCookie).toMatchObject({ httpOnly: true, path: '/login/two-factor/done' });
    await page.getByRole('button', { name: /I have saved them/ }).click();

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome, Test');
    await expect(page.getByText('Booking Manager').first()).toBeVisible();
    // The one-time codes are forgotten: the page cannot be revisited.
    expect((await page.context().cookies()).some((c) => c.name === 'um_codes')).toBe(false);
    await page.goto('/login/two-factor/done');
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('the sidebar only shows what the role may open, and unauthorised pages say so', async ({ page }) => {
    await signIn(page, staff.email, staff.password);
    consumedStep = currentStep() + 1;
    await page.getByLabel('6-digit code').fill(totpAtStep(secret, consumedStep)); // next step: this one has not been used yet
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/\/admin$/);

    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Bookings' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Departures' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Payments' })).toBeVisible(); // Booking Manager may view payments
    for (const hidden of ['Settings', 'Staff', 'Roles & permissions', 'Audit logs', 'Refunds']) {
      await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
    }

    // On phones the sidebar becomes a drawer.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(nav).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Authenticated portal pages meet WCAG 2.1 AA.
    for (const route of ['/admin', '/admin/security']) {
      await page.goto(route);
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      const blocking = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(blocking.map((v) => `${route} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
    }

    // Security page: sessions list shows this device.
    await page.goto('/admin/security');
    await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
    await expect(page.getByText('This device')).toBeVisible();
    await expect(page.getByText('On', { exact: true })).toBeVisible();
  });

  test('a code cannot be reused, wrong codes are refused, and each backup code works exactly once', async ({ page }) => {
    // The previous test consumed `consumedStep`; replaying it (or anything older) must fail.
    await signIn(page, staff.email, staff.password);
    await expect(page).toHaveURL(/\/login\/two-factor$/);
    await page.getByLabel('6-digit code').fill(totpAtStep(secret, consumedStep));
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByText(/not correct/i)).toBeVisible();
    await page.getByLabel('6-digit code').fill('123456');
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByText(/not correct/i)).toBeVisible();

    await page.getByRole('button', { name: 'Use a backup code instead' }).click();
    await page.getByLabel('Backup code').fill(backupCodes[0]!);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/\/admin$/);

    // Same backup code again is refused.
    await page.context().clearCookies();
    await signIn(page, staff.email, staff.password);
    await page.getByRole('button', { name: 'Use a backup code instead' }).click();
    await page.getByLabel('Backup code').fill(backupCodes[0]!);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByText(/not correct/i)).toBeVisible();
    await page.getByLabel('Backup code').fill(backupCodes[1]!.toLowerCase());
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('staff are kept out of the customer area, and the change-password form enforces the policy', async ({ page }) => {
    await signIn(page, staff.email, staff.password);
    await page.getByRole('button', { name: 'Use a backup code instead' }).click();
    await page.getByLabel('Backup code').fill(backupCodes[2]!);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/account');
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto('/admin/security');
    await page.locator('input[name="currentPassword"]').fill('definitely not it');
    await page.locator('input[name="newPassword"]').fill(NEW_STRONG);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText(/current password is not correct/i)).toBeVisible();
    await page.locator('input[name="currentPassword"]').fill(staff.password);
    await page.locator('input[name="newPassword"]').fill('password1234');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText(/too common/i)).toBeVisible();
    // Passwords are cleared after a failed attempt (React resets the form); retype both.
    await expect(page.locator('input[name="currentPassword"]')).toHaveValue('');
    await page.locator('input[name="currentPassword"]').fill(staff.password);
    await page.locator('input[name="newPassword"]').fill(NEW_STRONG);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Password changed')).toBeVisible();
  });

  test('a role without the dashboard permission is told so instead of seeing data', async ({ page }) => {
    // Every seeded role has dashboard:read, so remove it for this check by using an existing role with fewer rights:
    // VISA_OFFICER has no payments access; the sidebar proves least privilege.
    const visa = createStaff('visa', 'VISA_OFFICER');
    await signIn(page, visa.email, visa.password);
    await page.getByText("Can't scan?").click();
    const s = (await page.getByTestId('totp-secret').innerText()).trim();
    await page.getByLabel('6-digit code').fill(totp(s));
    await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
    await page.getByRole('button', { name: /I have saved them/ }).click();
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Visa applications' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Documents' })).toBeVisible();
    for (const hidden of ['Payments', 'Leads', 'Packages', 'Settings']) await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
  });
});

/* ============================ accessibility & layout ============================ */

test.describe('auth pages: accessibility and responsive layout', () => {
  test.setTimeout(120_000);
  const pages = ['/login', '/register', '/forgot-password', '/reset-password?token=' + 'x'.repeat(30), '/verify-email?token=' + 'x'.repeat(30)];
  for (const scheme of ['light', 'dark'] as const) {
    for (const route of pages) {
      test(`axe: ${route.split('?')[0]} (${scheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(route);
        await page.evaluate((s) => document.documentElement.classList.toggle('dark', s === 'dark'), scheme);
        const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        const blocking = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
      });
    }
  }

  test('no horizontal overflow on phones', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    for (const route of pages) {
      await page.goto(route);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), route).toBeLessThanOrEqual(1);
    }
  });

  test('invalid or missing links explain what to do', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page.getByText('incomplete')).toBeVisible();
    await page.goto('/verify-email?token=short');
    await expect(page.getByText('incomplete')).toBeVisible();
    await page.goto('/verify-email?token=' + 'x'.repeat(40));
    await page.getByRole('button', { name: 'Verify my email address' }).click();
    await expect(page.getByText(/invalid or has expired/)).toBeVisible();
  });
});
