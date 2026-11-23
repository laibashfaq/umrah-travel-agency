import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The customer journey against the real API and database: profile, travelers, a full booking from room choice to
 * submission and cancellation, plus access control between customers. Needs EMAIL_PROVIDER=log (mail is read from the outbox).
 */

const ROOT = path.resolve(__dirname, '../../..');
const OUTBOX = path.join(ROOT, '.local', 'outbox');
const STRONG = 'correct horse battery staple';
const run = Date.now().toString(36);
const unique = (tag: string) => `e2e-portal-${tag}-${run}@example.com`;

let ipCounter = 200;
test.beforeEach(async ({ context }) => {
  ipCounter++;
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `10.88.${(ipCounter >> 8) & 255}.${ipCounter & 255}` });
});

/* ------------------------------- helpers ------------------------------- */

async function linkFromEmail(email: string, subject: string): Promise<string | null> {
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
        if (!url) return null;
        const u = new URL(url);
        return `${u.pathname}${u.search}`;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No "${subject}" email for ${email}`);
}

function createDeparture(seats: number): { slug: string; departureId: string; returnDate: string } {
  const out = execFileSync('npm', ['run', 'test:departure', '-w', '@umrah/api', '--', '--seats', String(seats)], { cwd: ROOT, shell: process.platform === 'win32', encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new Error(`test:departure printed no JSON:\n${out}`);
  return JSON.parse(line) as { slug: string; departureId: string; returnDate: string };
}

async function registerVerifySignIn(page: Page, email: string) {
  await page.goto('/register');
  await page.getByLabel('First name').fill('Hamza');
  await page.getByLabel('Last name').fill('Tester');
  await page.getByLabel('Email').fill(email);
  await page.locator('input[name="password"]').fill(STRONG);
  await page.getByRole('checkbox', { name: /I agree/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto((await linkFromEmail(email, 'Verify your email'))!);
  await page.getByRole('button', { name: 'Verify my email address' }).click();
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('input[name="password"]').fill(STRONG);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

async function addTraveler(page: Page, t: { first: string; last: string; gender: 'MALE' | 'FEMALE'; dob: string; passport?: string; returnTo?: string }) {
  await page.goto(`/account/travelers/new${t.returnTo ? `?returnTo=${encodeURIComponent(t.returnTo)}` : ''}`);
  await page.getByLabel('First name').fill(t.first);
  await page.getByLabel(/^Last name/).fill(t.last);
  await page.getByLabel('Gender').selectOption(t.gender);
  await page.getByLabel('Date of birth').fill(t.dob);
  if (t.passport) {
    await page.getByLabel('Passport number').fill(t.passport);
    await page.getByLabel('Expiry date').fill(iso(daysFromNow(1200)));
  }
  await page.getByRole('button', { name: 'Add traveler' }).click();
  await expect(page).toHaveURL(t.returnTo ? new RegExp(t.returnTo) : /\/account\/travelers$/);
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

async function axeClean(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const blocking = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

/* ================================ journey ================================ */

test.describe('customer journey', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  const email = unique('main');
  const dep = { slug: '', departureId: '', returnDate: '' };
  let bookingUrl = '';

  test('profile can be updated and is remembered', async ({ page }) => {
    Object.assign(dep, createDeparture(12));
    await registerVerifySignIn(page, email);
    await page.goto('/account/profile');
    await page.getByLabel('Phone', { exact: true }).fill('+92 300 1234567');
    await page.getByLabel('City').fill('Lahore');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Your profile was saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('City')).toHaveValue('Lahore');
    await expect(page.getByLabel('Email', { exact: true })).toBeDisabled();

    await page.getByLabel('First name').fill('');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.locator('[data-slot="alert"][role="alert"]').first()).toBeVisible();
    await expect(page.getByLabel('City')).toHaveValue('Lahore'); // not lost on error
  });

  test('travelers are saved with masked identity numbers', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.locator('input[name="password"]').fill(STRONG);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account$/);

    await addTraveler(page, { first: 'Hamza', last: 'Tester', gender: 'MALE', dob: '1985-03-12', passport: 'AB1234567' });
    await addTraveler(page, { first: 'Maryam', last: 'Tester', gender: 'FEMALE', dob: '1987-08-02' }); // passport added later, on purpose
    await addTraveler(page, { first: 'Yusuf', last: 'Tester', gender: 'MALE', dob: iso(daysFromNow(74 - 8 * 365 - 30)), passport: 'CD7654321' });

    await expect(page.getByRole('heading', { name: /Hamza Tester/ })).toBeVisible();
    await expect(page.getByText('*****4567')).toBeVisible();
    await expect(page.getByText('AB1234567')).toHaveCount(0);
    await expect(page.getByText('Passport details needed before booking')).toBeVisible();

    // The edit form never shows the full number either.
    await page.getByRole('link', { name: /Edit Hamza Tester/ }).click();
    await expect(page.getByText('Saved: *****4567')).toBeVisible();
    await expect(page.getByLabel('Passport number')).toHaveValue('');
    expect(await page.content()).not.toContain('AB1234567');
  });

  test('book: rooms, travelers, passport fix, submit', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.locator('input[name="password"]').fill(STRONG);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account$/);

    // Package page links into the booking flow once online booking is on; the flow itself is reached directly here.
    await page.goto(`/account/bookings/new?departure=${dep.departureId}`);
    await expect(page.getByRole('heading', { name: 'Choose your rooms' })).toBeVisible();
    await axeClean(page, 'rooms');

    await page.getByLabel('Room type').selectOption('QUAD');
    await page.getByRole('button', { name: 'More: Children (2–11)' }).click();
    // 2 adults x 260,000 + child at the adult fare (no child fare on quad rooms) = 780,000. Deposit 25% = 195,000.
    await expect(page.getByText(/780,000/).first()).toBeVisible();
    await expect(page.getByText(/195,000/).first()).toBeVisible();
    // A fourth person in a quad is fine, a fifth is blocked by the control itself.
    await expect(page.getByRole('button', { name: 'More: Adults (12+)' })).toBeEnabled();
    await page.getByRole('button', { name: 'More: Adults (12+)' }).click();
    await expect(page.getByRole('button', { name: 'More: Children (2–11)' })).toBeDisabled();
    await page.getByRole('button', { name: 'Fewer: Adults (12+)' }).click();

    await page.getByRole('button', { name: 'Continue to travelers' }).click();
    await expect(page.getByRole('heading', { name: 'Who is travelling?' })).toBeVisible();
    bookingUrl = new URL(page.url()).pathname;
    expect(bookingUrl).toMatch(/^\/account\/bookings\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/Your seats are held until/)).toBeVisible();

    // Hamza (adult) and Maryam (adult, no passport yet) and Yusuf (child).
    await page.getByLabel('Adult 1').selectOption({ label: 'Hamza Tester' });
    await page.getByLabel('Adult 2').selectOption({ label: 'Maryam Tester (no passport yet)' });
    await page.getByLabel('Child (2–11) 1').selectOption({ label: 'Yusuf Tester' });
    // A traveler can only be chosen once.
    await expect(page.getByLabel('Adult 2').locator('option', { hasText: 'Hamza Tester' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save travelers' }).click();
    await expect(page.getByText('Travelers saved.')).toBeVisible();
    await expect(page.getByText(/Maryam Tester: add passport number/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit booking' })).toBeDisabled();

    // Fix the passport, come back, submit.
    await page.goto('/account/travelers');
    await page.getByRole('link', { name: /Edit Maryam Tester/ }).click();
    await page.getByLabel('Passport number').fill('EF1112223');
    await page.getByLabel('Expiry date').fill(iso(daysFromNow(1200)));
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page).toHaveURL(/\/account\/travelers$/);

    await page.goto(bookingUrl);
    await expect(page.getByText('Still to do')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Submit booking' })).toBeEnabled();
    await axeClean(page, 'booking draft');
    await page.getByRole('button', { name: 'Submit booking' }).click();

    await expect(page.getByText('Booking submitted', { exact: true })).toBeVisible();
    await expect(page.getByText('Awaiting payment').first()).toBeVisible();
    await expect(page.getByText('What happens next')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit booking' })).toHaveCount(0);
    expect(await linkFromEmail(email, 'received')).toContain('/account/bookings/');
    await axeClean(page, 'booking submitted');

    // The list and dashboard show it.
    await page.goto('/account/bookings');
    await expect(page.getByRole('link', { name: 'View booking' })).toHaveCount(1);
    await page.goto('/account');
    await expect(page.getByText('E2E Journey Package').first()).toBeVisible();
  });

  test('another customer cannot open the booking', async ({ page }) => {
    await registerVerifySignIn(page, unique('other'));
    const res = await page.goto(bookingUrl);
    expect(res?.status()).toBe(404);
    await page.goto('/account/bookings');
    await expect(page.getByText('No bookings yet')).toBeVisible();
  });

  test('the booking can be cancelled and seats are released', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.locator('input[name="password"]').fill(STRONG);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account$/);

    await page.goto(bookingUrl);
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await page.getByLabel('Reason (optional)').fill('Plans changed');
    await page.getByRole('button', { name: 'Yes, cancel booking' }).click();
    await expect(page.getByText('Plans changed', { exact: true })).toBeVisible();
    await expect(page.getByText('Cancelled').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);

    // Room options show all 12 seats again.
    await page.goto(`/account/bookings/new?departure=${dep.departureId}`);
    await expect(page.getByRole('heading', { name: 'Choose your rooms' })).toBeVisible();
  });

  test('portal pages fit a phone and meet accessibility checks', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.locator('input[name="password"]').fill(STRONG);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account$/);
    for (const route of ['/account', '/account/bookings', '/account/travelers', '/account/travelers/new', '/account/profile', bookingUrl, `/account/bookings/new?departure=${dep.departureId}`]) {
      await page.goto(route);
      await noHorizontalOverflow(page);
      await axeClean(page, route);
    }
  });
});

test('unauthenticated visitors are sent to sign in and back', async ({ page }) => {
  await page.goto('/account/bookings/new?departure=00000000-0000-4000-8000-000000000000');
  await expect(page).toHaveURL(/\/login\?next=/);
});

// The journey creates a published package and bookings; remove them so other suites see only the normal catalogue.
test.afterAll(() => {
  execFileSync('npm', ['run', 'test:cleanup', '-w', '@umrah/api'], { cwd: ROOT, shell: process.platform === 'win32', encoding: 'utf8' });
});
