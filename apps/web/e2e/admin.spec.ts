import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The staff portal against the real API and database: dashboard, booking handling, customers, package publishing,
 * role limits and the audit log. Staff accounts are created with two-factor pre-enabled (`--test-2fa`).
 */

const ROOT = path.resolve(__dirname, '../../..');
const run = Date.now().toString(36);

/* ------------------------------- helpers ------------------------------- */

function npmRun(args: string[]): string {
  return execFileSync('npm', ['run', ...args], { cwd: ROOT, shell: process.platform === 'win32', encoding: 'utf8' });
}

function createStaff(tag: string, role: string): { email: string; password: string; secret: string } {
  const email = `e2e-adm-${tag}-${run}@example.com`;
  const out = npmRun(['staff:create', '-w', '@umrah/api', '--', '--email', email, '--role', role, '--first', 'Test', '--last', tag, '--test-2fa']);
  const password = /Temporary password: (\S+)/.exec(out)?.[1];
  const secret = /Two-factor secret: (\S+)/.exec(out)?.[1];
  if (!password || !secret) throw new Error(`staff:create output not understood:\n${out}`);
  return { email, password, secret };
}

function createBooking(tag: string): { bookingId: string; reference: string; customerId: string; customerEmail: string; customerName: string; packageId: string; packageTitle: string } {
  const out = npmRun(['test:booking', '-w', '@umrah/api', '--', '--tag', tag]);
  const line = out.split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new Error(`test:booking printed no JSON:\n${out}`);
  return JSON.parse(line);
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

function totp(secret: string): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1]! & 15;
  const bin = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

async function staffSignIn(page: Page, s: { email: string; password: string; secret: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(s.email);
  await page.locator('input[name="password"]').fill(s.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\/two-factor$/);
  await page.getByLabel('6-digit code').fill(totp(s.secret));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function axeClean(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const blocking = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/* ================================ journey ================================ */

test.describe('staff portal', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  let page: Page;
  let admin: ReturnType<typeof createStaff>;
  let sales: ReturnType<typeof createStaff>;
  let booking: ReturnType<typeof createBooking>;
  const slug = `e2e-adm-pkg-${run}`;

  test.beforeAll(async ({ browser }) => {
    admin = createStaff('super', 'SUPER_ADMIN');
    sales = createStaff('sales', 'SALES_AGENT');
    booking = createBooking(run);
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.99.1.1' } });
    page = await context.newPage();
    await staffSignIn(page, admin);
  });

  test.afterAll(async () => {
    await page.context().close();
    npmRun(['test:cleanup', '-w', '@umrah/api']);
  });

  test('the dashboard shows real figures and the new booking', async () => {
    await page.goto('/admin');
    await expect(page.getByText('Awaiting payment').first()).toBeVisible();
    await expect(page.getByRole('link', { name: booking.reference })).toBeVisible();
    await axeClean(page, 'dashboard');
  });

  test('bookings can be searched, filtered and opened', async () => {
    await page.goto('/admin/bookings');
    await page.getByLabel('Search', { exact: true }).fill(booking.reference);
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByRole('link', { name: new RegExp(booking.reference) })).toBeVisible();
    await expect(page.getByRole('table')).toContainText(booking.customerName);
    await axeClean(page, 'bookings list');

    await page.getByLabel('Status').selectOption('CONFIRMED');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByText('No bookings match')).toBeVisible();

    await page.goto(`/admin/bookings/${booking.bookingId}`);
    await expect(page.getByRole('heading', { level: 1, name: booking.reference })).toBeVisible();
    await expect(page.getByText(booking.customerEmail)).toBeVisible();
    await expect(page.getByText(/\*{3,}\w{4}/).first()).toBeVisible(); // masked passport
    await axeClean(page, 'booking detail');
  });

  test('notes, assignment and status changes work and are recorded', async () => {
    await page.goto(`/admin/bookings/${booking.bookingId}`);

    await page.getByLabel('Add an internal note').fill('Called the customer; deposit by bank transfer on Friday.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('Called the customer; deposit by bank transfer on Friday.')).toBeVisible();

    await page.getByLabel('Handled by').selectOption({ label: `Test super` });
    await page.getByRole('button', { name: 'Save assignment' }).click();
    await expect(page.getByText('Assignment saved.')).toBeVisible();

    // Confirming records no payment.
    await page.getByLabel('Move to').selectOption('CONFIRMED');
    await page.getByLabel(/Note \(optional\)/).fill('Deposit received by bank transfer');
    await page.getByRole('button', { name: 'Update status' }).click();
    await expect(page.getByText('Booking updated.')).toBeVisible();
    await expect(page.getByText('Confirmed').first()).toBeVisible();
    await expect(page.getByText('Unpaid').first()).toBeVisible();
    await expect(page.getByText('Deposit received by bank transfer')).toBeVisible();

    // Cancelling needs a reason.
    await page.getByLabel('Move to').selectOption('CANCELLED');
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(page.locator('[data-slot="alert"][role="alert"]').first()).toContainText(/reason/i);
    await page.getByLabel('Reason (required)').fill('Customer withdrew');
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(page.getByText('Booking updated.')).toBeVisible();
    await expect(page.getByText('This booking is finished')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: booking.reference })).toBeVisible();
  });

  test('customers can be found and show their bookings', async () => {
    await page.goto('/admin/customers');
    await page.getByLabel('Search', { exact: true }).fill(booking.customerEmail);
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('link', { name: booking.customerName }).click();
    await expect(page.getByRole('heading', { level: 1, name: booking.customerName })).toBeVisible();
    await expect(page.getByRole('link', { name: booking.reference })).toBeVisible();
    await page.getByLabel('Add an internal note').fill('Prefers WhatsApp calls.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('Prefers WhatsApp calls.')).toBeVisible();
    await axeClean(page, 'customer detail');
  });

  test('a package can be created, priced, published and archived', async () => {
    await page.goto('/admin/packages/new');
    await page.getByLabel(/^Title/).fill('E2E Admin Package');
    await page.getByLabel(/^Web address/).fill(slug);
    await page.getByLabel('Days in total').fill('10');
    await page.getByLabel('Nights in Makkah').fill('5');
    await page.getByLabel('Nights in Madinah').fill('4');
    await page.getByLabel('Departure cities').fill('Karachi\nLahore');
    await page.getByLabel('Inclusions').fill('Visa\nHotels');
    await page.getByRole('button', { name: 'Create package' }).click();
    await expect(page.getByText(/created as a draft/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Admin Package' })).toBeVisible();

    // Not sellable yet: publishing is refused and explained.
    await expect(page.getByText(/Add an upcoming departure/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.locator('[data-slot="alert"][role="alert"]').first()).toContainText(/Cannot publish/);
    expect((await page.request.get(`/packages/${slug}`)).status()).toBe(404);

    await page.getByRole('button', { name: 'Add departure' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Departure date/).fill(isoDay(90));
    await dialog.getByLabel(/^Return date/).fill(isoDay(100));
    await dialog.getByLabel('Departing from').fill('Karachi');
    await dialog.getByLabel('Double adult price').fill('320000');
    await dialog.getByLabel('Quad adult price').fill('280000');
    await dialog.getByRole('button', { name: 'Add departure' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await expect(page.getByText(/Quad.*280,000/)).toBeVisible();
    await expect(page.getByText(/From .*280,000/)).toBeVisible();

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Published').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /View on site/ })).toBeVisible();
    const publicPage = await page.request.get(`/packages/${slug}`);
    expect(publicPage.status()).toBe(200);
    expect(await publicPage.text()).toContain('E2E Admin Package');

    // The address cannot be changed while live.
    await expect(page.getByLabel(/^Web address/)).toHaveAttribute('readonly', '');
    await axeClean(page, 'package detail');

    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('Archived').first()).toBeVisible();
    expect((await page.request.get(`/packages/${slug}`)).status()).toBe(404);
  });

  test('lists, roles, staff and the audit log are reachable and accessible', async () => {
    for (const [route, heading] of [
      ['/admin/packages', 'Packages'],
      ['/admin/staff', 'Staff'],
      ['/admin/roles', 'Roles & permissions'],
      ['/admin/audit-logs', 'Audit logs'],
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await axeClean(page, route);
    }
    await page.goto(`/admin/audit-logs?entityId=${booking.bookingId}`);
    await expect(page.getByText('booking.status_changed').first()).toBeVisible();
    await expect(page.getByText('booking.note_added')).toBeVisible();
  });

  test('pages fit a phone', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/admin', '/admin/bookings', `/admin/bookings/${booking.bookingId}`, '/admin/customers', '/admin/packages', `/admin/packages/${booking.packageId}`, '/admin/audit-logs']) {
      await page.goto(route);
      const overflow = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right > limit + 1)
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(el.getBoundingClientRect().right)}`);
        return { by: document.documentElement.scrollWidth - limit, wide };
      });
      expect(overflow.by, `${route} overflows by ${overflow.by}px: ${overflow.wide.join(' | ')}`).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('a sales agent sees only what the role allows', async ({ browser }) => {
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.99.1.2' } });
    const p = await context.newPage();
    await staffSignIn(p, sales);

    await p.goto(`/admin/bookings/${booking.bookingId}`);
    // The booking was cancelled earlier, so the panel says it is finished; either way a sales agent has no controls.
    await expect(p.getByText('This booking is finished')).toBeVisible();
    await expect(p.getByRole('button', { name: 'Update status' })).toHaveCount(0);
    await expect(p.getByRole('button', { name: 'Add note' })).toHaveCount(0); // needs bookings:update

    await p.goto('/admin/packages');
    await expect(p.getByRole('heading', { level: 1, name: 'Packages' })).toBeVisible();
    await expect(p.getByRole('link', { name: 'New package' })).toHaveCount(0);
    await p.goto('/admin/packages/new');
    await expect(p.getByText('You do not have access')).toBeVisible();
    await p.goto('/admin/staff');
    await expect(p.getByText('You do not have access')).toBeVisible();
    await p.goto('/admin/audit-logs');
    await expect(p.getByText('You do not have access')).toBeVisible();
    await context.close();
  });
});
