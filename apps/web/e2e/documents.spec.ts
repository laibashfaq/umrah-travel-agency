import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Documents and visas in the browser: a customer uploads a passport and photo, a visa officer reviews them and
 * takes the application through to an issued visa, and the customer sees each step. Files stay private throughout.
 */

const ROOT = path.resolve(__dirname, '../../..');
const run = Date.now().toString(36);

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/* ------------------------------- helpers ------------------------------- */

function npmRun(args: string[]): string {
  return execFileSync('npm', ['run', ...args], { cwd: ROOT, shell: process.platform === 'win32', encoding: 'utf8' });
}

function createStaff(tag: string, role: string): { email: string; password: string; secret: string } {
  const email = `e2e-doc-${tag}-${run}@example.com`;
  const out = npmRun(['staff:create', '-w', '@umrah/api', '--', '--email', email, '--role', role, '--first', 'Test', '--last', tag, '--test-2fa']);
  const password = /Temporary password: (\S+)/.exec(out)?.[1];
  const secret = /Two-factor secret: (\S+)/.exec(out)?.[1];
  if (!password || !secret) throw new Error(`staff:create output not understood:\n${out}`);
  return { email, password, secret };
}

function createBooking(tag: string) {
  const out = npmRun(['test:booking', '-w', '@umrah/api', '--', '--tag', tag, '--login', '--confirmed']);
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

async function axeClean(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const blocking = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

async function uploadFile(page: Page, type: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto('/account/documents');
  await page.getByLabel(/^Document/).selectOption(type);
  await page.getByLabel(/^File/).setInputFiles(file);
  await page.getByRole('button', { name: 'Upload document' }).click();
}

const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/* ================================ journey ================================ */

test.describe('documents and visa', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  let customer: Page;
  let officer: Page;
  let b: ReturnType<typeof createBooking>;
  let visaUrl = '';
  let downloadHref = '';

  test.beforeAll(async ({ browser }) => {
    const off = createStaff('visa', 'VISA_OFFICER');
    b = createBooking(run);
    const ctx = (ip: string) => browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
    customer = await (await ctx('10.97.1.1')).newPage();
    officer = await (await ctx('10.97.1.2')).newPage();
    await customer.goto('/login');
    await customer.getByLabel('Email').fill(b.customerEmail);
    await customer.locator('input[name="password"]').fill(b.password);
    await customer.getByRole('button', { name: 'Sign in' }).click();
    await expect(customer).toHaveURL(/\/account$/);
    await staffSignIn(officer, off);
  });

  test.afterAll(async () => {
    await Promise.all([customer.context().close(), officer.context().close()]);
    npmRun(['test:cleanup', '-w', '@umrah/api']);
  });

  test('the customer uploads a passport; a disguised file is refused', async () => {
    await customer.goto('/account/documents');
    await expect(customer.getByText('Not uploaded').first()).toBeVisible();
    await axeClean(customer, 'customer documents');

    // An HTML file renamed to .pdf is not a PDF.
    await uploadFile(customer, 'PASSPORT', { name: 'passport.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
    await expect(customer.locator('[data-slot="alert"][role="alert"]').first()).toContainText(/PDF, JPEG or PNG/);

    await uploadFile(customer, 'PASSPORT', { name: 'My passport.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(customer.getByText('Document uploaded. We will review it shortly.')).toBeVisible();
    await expect(customer.getByText('Pending review').first()).toBeVisible();
    await expect(customer.getByText(/My passport\.pdf · /)).toBeVisible();

    await uploadFile(customer, 'PHOTO', { name: 'photo.png', mimeType: 'image/png', buffer: PNG });
    await expect(customer.getByText('Document uploaded. We will review it shortly.')).toBeVisible();

    // The file comes back as a download, exactly as uploaded, and is never cached.
    downloadHref = (await customer.getByRole('link', { name: /Download My passport\.pdf/ }).getAttribute('href'))!;
    const res = await customer.request.get(downloadHref);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect((await res.body()).equals(PDF)).toBe(true);
  });

  test('nobody else can fetch the file', async ({ browser }) => {
    const anon = await browser.newContext();
    const res = await anon.request.get(downloadHref, { maxRedirects: 0 });
    expect(res.status()).not.toBe(200);
    expect((await res.body()).includes(Buffer.from('%PDF'))).toBe(false);
    await anon.close();

    // A staff member signed in to the staff portal cannot use the customer link either, and a role without
    // document access gets nothing from the staff link.
    const sales = createStaff('sales', 'SALES_AGENT');
    const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.97.1.3' } });
    const p = await ctx.newPage();
    await staffSignIn(p, sales);
    const id = downloadHref.split('/')[3]!;
    const viaStaff = await p.request.get(`/admin/documents/${id}/file`);
    expect(viaStaff.status()).toBe(403);
    expect((await viaStaff.body()).includes(Buffer.from('%PDF'))).toBe(false);
    await p.goto('/admin/documents');
    await expect(p.getByText('You do not have access')).toBeVisible();
    await ctx.close();
  });

  test('the officer opens applications and reviews the documents', async () => {
    await officer.goto(`/admin/bookings/${b.bookingId}`);
    await officer.getByRole('button', { name: 'Start visa applications' }).click();
    await expect(officer.getByText('Documents pending').first()).toBeVisible();
    await officer.locator('a[href^="/admin/visas/"]').first().click(); // the traveler's application in the Visas card
    await expect(officer).toHaveURL(/\/admin\/visas\/[0-9a-f-]{36}/);
    visaUrl = new URL(officer.url()).pathname;
    await expect(officer.getByText(/Not yet approved: Passport \(photo page\), Passport-style photo/)).toBeVisible();
    await axeClean(officer, 'visa detail');

    // Cannot jump ahead while documents are unapproved.
    await officer.getByLabel('Move to').selectOption('UNDER_REVIEW');
    await officer.getByRole('button', { name: 'Update application' }).click();
    await expect(officer.getByText('Application updated.')).toBeVisible();
    await officer.getByLabel('Move to').selectOption('READY_TO_SUBMIT');
    await officer.getByRole('button', { name: 'Update application' }).click();
    await expect(officer.locator('[data-slot="alert"][role="alert"]').first()).toContainText(/Approve .* first/);

    // The review queue: approve the passport, send the photo back.
    await officer.goto('/admin/documents');
    await axeClean(officer, 'documents queue');
    const passportRow = officer.getByRole('row').filter({ hasText: 'My passport.pdf' });
    const opened = await officer.request.get((await passportRow.getByRole('link', { name: /Open/ }).getAttribute('href'))!);
    expect(opened.status()).toBe(200);
    await passportRow.getByRole('button', { name: /Approve/ }).click();
    await expect(officer.getByText('Document approved.')).toBeVisible();

    const photoRow = officer.getByRole('row').filter({ hasText: 'photo.png' });
    await photoRow.getByRole('button', { name: /Reject/ }).click();
    await officer.getByRole('dialog').getByLabel(/What needs fixing/).fill('Background must be white');
    await officer.getByRole('dialog').getByRole('button', { name: 'Reject document' }).click();
    await expect(officer.getByText('Document rejected.')).toBeVisible();
    await expect(officer.getByText('Nothing is waiting for review')).toBeVisible();
  });

  test('the customer sees what to fix, uploads again, and the visa is issued', async () => {
    await customer.goto('/account/documents');
    await expect(customer.getByText('Please upload again: Background must be white')).toBeVisible();
    await expect(customer.getByText('Needs re-upload').first()).toBeVisible();
    // Approved files can no longer be removed by the customer.
    await expect(customer.getByRole('button', { name: /Remove My passport\.pdf/ })).toHaveCount(0);
    await uploadFile(customer, 'PHOTO', { name: 'photo-white.png', mimeType: 'image/png', buffer: PNG });
    await expect(customer.getByText('Document uploaded. We will review it shortly.')).toBeVisible();

    await customer.goto('/account/visa');
    await expect(customer.getByText('We are checking your documents.')).toBeVisible();
    await axeClean(customer, 'customer visa');

    // Officer approves the new photo from the application page and moves it along.
    await officer.goto(visaUrl);
    await officer.getByRole('listitem').filter({ hasText: 'photo-white.png' }).getByRole('button', { name: /Approve/ }).click();
    await expect(officer.getByText('Document approved.')).toBeVisible();
    const step = async (status: string, fill?: () => Promise<void>) => {
      await officer.getByLabel('Move to').selectOption(status);
      if (fill) await fill();
      await officer.getByRole('button', { name: 'Update application' }).click();
      await expect(officer.getByText('Application updated.')).toBeVisible();
    };
    await step('READY_TO_SUBMIT');
    await step('SUBMITTED', async () => {
      await officer.getByLabel('Application number').fill('APP-2001');
    });
    await step('IN_PROCESS');
    await step('APPROVED');

    // Issuing without the visa details is refused, and the choice survives the error.
    await officer.getByLabel('Move to').selectOption('ISSUED');
    await officer.getByRole('button', { name: 'Update application' }).click();
    await expect(officer.getByText('Enter the visa number')).toBeVisible();
    await expect(officer.getByLabel('Move to')).toHaveValue('ISSUED');
    await officer.getByLabel(/^Visa number/).fill('V-556677');
    await officer.getByLabel(/^Valid from/).fill(isoDay(50));
    await officer.getByLabel(/^Valid until/).fill(isoDay(80));
    await officer.getByRole('button', { name: 'Update application' }).click();
    await expect(officer.getByText('This application is finished.')).toBeVisible();
    await expect(officer.getByText('Visa issued').first()).toBeVisible();

    await customer.goto('/account/visa');
    await expect(customer.getByText('Your visa has been issued.')).toBeVisible();
    await expect(customer.getByText('V-556677')).toBeVisible();
    await expect(customer.getByText('APP-2001')).toHaveCount(0); // internal reference stays internal
  });

  test('pages fit a phone and the visa list is accessible', async () => {
    await officer.goto('/admin/visas');
    await expect(officer.getByRole('table')).toContainText(b.customerName);
    await axeClean(officer, 'visa list');
    const check = async (p: Page, route: string) => {
      const o = await p.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > limit + 1).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}`);
        return { by: document.documentElement.scrollWidth - limit, wide };
      });
      expect(o.by, `${route} overflows by ${o.by}px: ${o.wide.join(' | ')}`).toBeLessThanOrEqual(1);
    };
    await officer.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/admin/documents?status=ALL', '/admin/visas', visaUrl]) {
      await officer.goto(route);
      await check(officer, route);
    }
    await customer.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/account/documents', '/account/visa']) {
      await customer.goto(route);
      await check(customer, route);
    }
  });
});
