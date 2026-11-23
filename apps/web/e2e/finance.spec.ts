import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Money, end to end in the browser: a customer reports a payment, finance verifies it, the booking confirms and the
 * invoice updates; a second payment is rejected with a reason; a refund goes through request, approval and payout.
 */

const ROOT = path.resolve(__dirname, '../../..');
const run = Date.now().toString(36);

/* ------------------------------- helpers ------------------------------- */

function npmRun(args: string[]): string {
  return execFileSync('npm', ['run', ...args], { cwd: ROOT, shell: process.platform === 'win32', encoding: 'utf8' });
}

function createStaff(tag: string, role: string): { email: string; password: string; secret: string } {
  const email = `e2e-fin-${tag}-${run}@example.com`;
  const out = npmRun(['staff:create', '-w', '@umrah/api', '--', '--email', email, '--role', role, '--first', 'Test', '--last', tag, '--test-2fa']);
  const password = /Temporary password: (\S+)/.exec(out)?.[1];
  const secret = /Two-factor secret: (\S+)/.exec(out)?.[1];
  if (!password || !secret) throw new Error(`staff:create output not understood:\n${out}`);
  return { email, password, secret };
}

function createBooking(tag: string) {
  const out = npmRun(['test:booking', '-w', '@umrah/api', '--', '--tag', tag, '--login']);
  const line = out.split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new Error(`test:booking printed no JSON:\n${out}`);
  return JSON.parse(line) as { bookingId: string; reference: string; customerEmail: string; customerName: string; password: string };
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

async function customerSignIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
}

async function axeClean(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const blocking = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

/* ================================ journey ================================ */

test.describe('payments, invoices and refunds', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  let customer: Page;
  let finance: Page;
  let approver: Page;
  let b: ReturnType<typeof createBooking>;
  const txRef = `E2E-${run}`;

  test.beforeAll(async ({ browser }) => {
    const fin = createStaff('fin', 'FINANCE_OFFICER');
    const adm = createStaff('adm', 'SUPER_ADMIN');
    b = createBooking(run);
    const ctx = (ip: string) => browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
    customer = await (await ctx('10.98.1.1')).newPage();
    finance = await (await ctx('10.98.1.2')).newPage();
    approver = await (await ctx('10.98.1.3')).newPage();
    await customerSignIn(customer, b.customerEmail, b.password);
    await staffSignIn(finance, fin);
    await staffSignIn(approver, adm);
  });

  test.afterAll(async () => {
    await Promise.all([customer.context().close(), finance.context().close(), approver.context().close()]);
    npmRun(['test:cleanup', '-w', '@umrah/api']);
  });

  test('the customer reports a payment and sees it waiting', async () => {
    await customer.goto(`/account/bookings/${b.bookingId}`);
    await expect(customer.getByRole('heading', { name: 'Payments' })).toBeVisible();
    await expect(customer.getByText('How to pay')).toBeVisible();
    await expect(customer.getByText('Our team will send you our bank details')).toBeVisible(); // no invented bank details

    await customer.getByLabel(/^Amount paid/).fill('999999'); // more than is due
    await customer.getByLabel(/^Transaction or receipt/).fill(txRef);
    await customer.getByRole('button', { name: 'Tell us I have paid' }).click();
    await expect(customer.getByText(/At most 300000/)).toBeVisible(); // shown beside the amount field
    await expect(customer.getByLabel(/^Transaction or receipt/)).toHaveValue(txRef); // not lost on error

    await customer.getByLabel(/^Amount paid/).fill('75000');
    await customer.getByRole('button', { name: 'Tell us I have paid' }).click();
    await expect(customer.getByText('Thank you, we have your payment details')).toBeVisible();
    await expect(customer.getByText('Awaiting verification')).toBeVisible();
    await expect(customer.locator('dt:has-text("Paid so far") + dd')).toHaveText(/Rs.0$/);
    await customer.goto('/account/payments');
    await expect(customer.getByRole('table')).toContainText('Awaiting verification');
    await axeClean(customer, 'customer payments');
  });

  test('finance verifies it: the booking confirms and the balance falls', async () => {
    await finance.goto('/admin/payments?status=AWAITING_VERIFICATION');
    const row = finance.getByRole('row').filter({ hasText: b.reference });
    await expect(row).toContainText(/75,000/);
    await axeClean(finance, 'admin payments');
    await row.getByRole('button', { name: /Verify/ }).click();
    await expect(finance.getByText('Payment verified.')).toBeVisible();

    await finance.goto(`/admin/bookings/${b.bookingId}`);
    await expect(finance.getByText('Confirmed').first()).toBeVisible();
    await expect(finance.getByText('Deposit paid').first()).toBeVisible();
    await expect(finance.getByText(/checked by Test fin/)).toBeVisible();
    await axeClean(finance, 'admin booking money');
  });

  test('the customer sees the confirmation and the invoice reflects the payment', async () => {
    await customer.goto(`/account/bookings/${b.bookingId}`);
    await expect(customer.getByText('Confirmed').first()).toBeVisible();
    await expect(customer.getByText('Successful')).toBeVisible();
    await expect(customer.getByText('Made a payment?')).toBeVisible(); // the balance is still open

    // No invoice yet (the fixture bypasses submission): staff issue it, the customer opens it.
    await finance.goto(`/admin/bookings/${b.bookingId}`);
    await finance.getByRole('button', { name: 'Issue invoice' }).click();
    await expect(finance.getByRole('link', { name: /^Invoice INV-/ })).toBeVisible();

    await customer.reload();
    await customer.getByRole('link', { name: /View invoice INV-/ }).click();
    await expect(customer.getByRole('article', { name: /Invoice INV-/ })).toBeVisible();
    await expect(customer.getByText('Partially paid')).toBeVisible();
    await expect(customer.getByRole('article').getByText(/225,000/).first()).toBeVisible(); // balance due
    await expect(customer.getByRole('button', { name: /Print or save as PDF/ })).toBeVisible();
    await axeClean(customer, 'invoice');
  });

  test('a payment that cannot be found is rejected with a reason the customer can read', async () => {
    await customer.goto(`/account/bookings/${b.bookingId}`);
    await customer.getByLabel(/^Amount paid/).fill('10000');
    await customer.getByLabel(/^Transaction or receipt/).fill(`${txRef}-B`);
    await customer.getByRole('button', { name: 'Tell us I have paid' }).click();
    await expect(customer.getByText('Thank you, we have your payment details')).toBeVisible();

    await finance.goto('/admin/payments?status=AWAITING_VERIFICATION');
    const row = finance.getByRole('row').filter({ hasText: b.reference });
    await row.getByRole('button', { name: /Reject/ }).click();
    await finance.getByRole('dialog').getByLabel(/^Reason/).fill('No such transfer on the statement');
    await finance.getByRole('dialog').getByRole('button', { name: 'Reject payment' }).click();
    await expect(finance.getByText('Payment rejected.').first()).toBeVisible();

    await customer.goto(`/account/bookings/${b.bookingId}`);
    await expect(customer.getByText('No such transfer on the statement')).toBeVisible();
  });

  test('a refund needs a second person and only changes the booking once paid out', async () => {
    await finance.goto(`/admin/bookings/${b.bookingId}`);
    await finance.getByRole('button', { name: /Refund/ }).first().click();
    await finance.getByRole('dialog').getByLabel(/^Amount/).fill('25000');
    await finance.getByRole('dialog').getByLabel(/^Reason/).fill('Customer reduced travelers');
    await finance.getByRole('dialog').getByRole('button', { name: 'Request refund' }).click();
    await expect(finance.getByText(/Refund requested/)).toBeVisible();

    // The requester cannot approve their own request.
    await finance.goto('/admin/refunds?status=REQUESTED');
    const own = finance.getByRole('row').filter({ hasText: b.reference });
    await own.getByRole('button', { name: 'Approve' }).click();
    await expect(finance.getByText(/Someone else must approve/)).toBeVisible();

    await approver.goto('/admin/refunds?status=REQUESTED');
    await axeClean(approver, 'admin refunds');
    const row = approver.getByRole('row').filter({ hasText: b.reference });
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(approver.getByText('Refund updated.')).toBeVisible();

    await approver.goto(`/admin/bookings/${b.bookingId}`);
    await expect(approver.getByText('Refunded').first()).toBeVisible(); // label of the money tile
    await expect(approver.getByText(/Approved/)).toBeVisible();

    await approver.goto('/admin/refunds?status=APPROVED');
    await approver.getByRole('row').filter({ hasText: b.reference }).getByLabel('Note or bank reference').fill('Bank ref RF-1');
    await approver.getByRole('row').filter({ hasText: b.reference }).getByRole('button', { name: 'Mark as paid' }).click();
    await expect(approver.getByText('Refund updated.')).toBeVisible();

    await customer.goto('/account/payments');
    await expect(customer.getByRole('table')).toContainText('Partially refunded');
    await customer.goto(`/account/bookings/${b.bookingId}`);
    await expect(customer.locator('dt:has-text("Paid so far") + dd')).toHaveText(/50,000/); // 75,000 - 25,000
  });

  test('finance pages meet accessibility checks and fit a phone', async () => {
    for (const route of ['/admin/payments', '/admin/refunds', '/admin/invoices']) {
      await finance.goto(route);
      await axeClean(finance, route);
    }
    await finance.setViewportSize({ width: 390, height: 844 });
    await customer.setViewportSize({ width: 390, height: 844 });
    const overflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    for (const route of ['/admin/payments', '/admin/refunds', '/admin/invoices', `/admin/bookings/${b.bookingId}`]) {
      await finance.goto(route);
      expect(await overflow(finance), route).toBeLessThanOrEqual(1);
    }
    for (const route of ['/account/payments', '/account/invoices', `/account/bookings/${b.bookingId}`]) {
      await customer.goto(route);
      expect(await overflow(customer), route).toBeLessThanOrEqual(1);
    }
  });

  test('a sales agent cannot reach the money screens', async ({ browser }) => {
    const s = createStaff('sales', 'SALES_AGENT');
    const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.98.1.4' } });
    const p = await ctx.newPage();
    await staffSignIn(p, s);
    for (const route of ['/admin/payments', '/admin/refunds', '/admin/invoices']) {
      await p.goto(route);
      await expect(p.getByText('You do not have access')).toBeVisible();
    }
    await p.goto(`/admin/bookings/${b.bookingId}`);
    await expect(p.getByRole('heading', { level: 3, name: 'Record a payment' })).toHaveCount(0);
    await expect(p.getByText('Money')).toHaveCount(0);
    await ctx.close();
  });
});
