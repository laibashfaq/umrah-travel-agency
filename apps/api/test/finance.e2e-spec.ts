import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
const INTERNAL_KEY = 'e2e-internal-key-0123456789abcdef';
process.env.INTERNAL_API_KEY = INTERNAL_KEY;
process.env.EMAIL_PROVIDER = 'log';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { RoleKey } from '@umrah/shared';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { generateTotpSecret, totpAt } from '../src/auth/totp';
import { configureApp } from '../src/bootstrap';
import { FieldEncryption } from '../src/common/crypto/field-encryption';
import { ENV } from '../src/config/config.module';
import { MailerService } from '../src/mail/mailer.service';
import { PrismaService } from '../src/prisma/prisma.service';

class CapturingMailer {
  sent: { template: string; to: string; vars: Record<string, string> }[] = [];
  async sendTemplate(template: string, to: string, vars: Record<string, string>) {
    this.sent.push({ template, to, vars });
    return 'NOT_DELIVERED' as const;
  }
  async send() {
    return 'NOT_DELIVERED' as const;
  }
}

const PASSWORD = 'correct horse battery staple';
const runId = Date.now().toString(36);
const day = (offset: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + offset));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const today = () => ymd(new Date());

type Method = 'get' | 'post' | 'put' | 'delete';

describe('Payments, invoices and refunds (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const mailer = new CapturingMailer();
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const packageIds: string[] = [];
  let ipCounter = 0;
  const freshIp = () => `10.79.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;

  const call = (method: Method, url: string, opts: { body?: object; token?: string } = {}) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`).set('x-internal-key', INTERNAL_KEY).set('x-client-ip', freshIp());
    if (opts.token) r = r.set('Authorization', `Bearer ${opts.token}`);
    return opts.body ? r.send(opts.body) : r;
  };

  async function customer(tag: string) {
    const email = `e2e-fin-${tag}-${runId}@example.com`;
    const user = await prisma.user.create({
      data: { email, passwordHash: await app.get(PasswordService).hash(PASSWORD), type: 'CUSTOMER', status: 'ACTIVE', firstName: 'Cust', lastName: tag, emailVerifiedAt: new Date() },
    });
    const c = await prisma.customer.create({ data: { userId: user.id, firstName: 'Cust', lastName: tag, email } });
    userIds.push(user.id);
    customerIds.push(c.id);
    const login = await call('post', '/auth/login', { body: { email, password: PASSWORD } }).expect(200);
    return { customerId: c.id, email, token: login.body.tokens.accessToken as string };
  }

  async function staff(tag: string, role: RoleKey) {
    const email = `e2e-fin-staff-${tag}-${runId}@example.com`;
    const secret = generateTotpSecret();
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role } });
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await app.get(PasswordService).hash(PASSWORD),
        type: 'STAFF',
        status: 'ACTIVE',
        firstName: 'Staff',
        lastName: tag,
        emailVerifiedAt: new Date(),
        twoFactorEnabled: true,
        twoFactorSecretEnc: app.get(FieldEncryption).encrypt(secret),
        roles: { create: { roleId: roleRow.id } },
      },
    });
    userIds.push(user.id);
    const first = await call('post', '/auth/login', { body: { email, password: PASSWORD } }).expect(200);
    const second = await call('post', '/auth/2fa/verify', { body: { challengeToken: first.body.challengeToken, code: totpAt(secret, Date.now()) } }).expect(200);
    return { id: user.id, email, token: second.body.tokens.accessToken as string };
  }

  /** A customer with a submitted booking: one adult in a double room at 300,000 (deposit 25% = 75,000). */
  async function submittedBooking(tag: string) {
    const c = await customer(tag);
    const pkg = await prisma.package.create({
      data: {
        slug: `e2e-fin-${tag}-${runId}`,
        title: `E2E Finance ${tag}`,
        durationDays: 14,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        depositType: 'PERCENTAGE',
        depositValue: 25,
        departures: { create: { departureDate: day(60), returnDate: day(74), seatsTotal: 10, status: 'OPEN', prices: { create: [{ occupancy: 'DOUBLE', adultPrice: '300000.00' }] } } },
      },
      include: { departures: true },
    });
    packageIds.push(pkg.id);
    const b = (await call('post', '/me/bookings', { token: c.token, body: { departureId: pkg.departures[0]!.id, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(201)).body;
    const t = (
      await call('post', '/me/travelers', {
        token: c.token,
        body: { firstName: 'Ali', lastName: tag, gender: 'MALE', dateOfBirth: '1980-01-01', nationality: 'PK', passportNumber: `FN${runId.toUpperCase().slice(0, 5)}${tag.length}`.padEnd(7, '0'), passportExpiryDate: ymd(day(1200)) },
      }).expect(201)
    ).body;
    await call('put', `/me/bookings/${b.id}/travelers`, { token: c.token, body: { leadTravelerId: t.id, assignments: [{ roomIndex: 0, travelerId: t.id }] } }).expect(200);
    await call('post', `/me/bookings/${b.id}/submit`, { token: c.token }).expect(200);
    return { ...c, bookingId: b.id as string, reference: b.reference as string, departureId: pkg.departures[0]!.id };
  }

  const report = (token: string, bookingId: string, amount: string, extra: Record<string, unknown> = {}) =>
    call('post', '/me/payments', { token, body: { bookingId, method: 'BANK_TRANSFER', amount, paidOn: today(), ...extra } });
  const booking = async (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailerService).useValue(mailer).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ENV));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.refund.deleteMany({ where: { booking: { customerId: { in: customerIds } } } });
    await prisma.payment.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.invoice.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.booking.deleteMany({ where: { OR: [{ customerId: { in: customerIds } }, { packageId: { in: packageIds } }] } });
    await prisma.traveler.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.packageDeparture.deleteMany({ where: { packageId: { in: packageIds } } });
    await prisma.package.deleteMany({ where: { id: { in: packageIds } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { status: 'DEACTIVATED', deletedAt: new Date() } });
    await prisma.session.updateMany({ where: { userId: { in: userIds }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'test_cleanup' } });
    await app?.close();
  });

  /* ------------------------------ invoices ------------------------------ */

  it('issues an invoice when a booking is submitted, and customers see only their own', async () => {
    const b = await submittedBooking('inv');
    const list = (await call('get', '/me/invoices', { token: b.token }).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'ISSUED', total: '300000.00', amountPaid: '0.00', balanceDue: '300000.00', bookingReference: b.reference });
    expect(list[0].number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(list[0].lines).toHaveLength(1);
    expect(list[0].lines[0]).toMatchObject({ quantity: 1, unitPrice: '300000.00', total: '300000.00' });
    expect(list[0].lines.reduce((n: number, l: { total: string }) => n + Number(l.total), 0)).toBe(300000);

    const other = await customer('inv-other');
    await call('get', `/me/invoices/${list[0].id}`, { token: other.token }).expect(404);
    expect((await call('get', '/me/invoices', { token: other.token }).expect(200)).body).toEqual([]);
  });

  /* ------------------------------ reporting ------------------------------ */

  describe('customer payment reports', () => {
    it('creates a payment that does not count until finance verifies it', async () => {
      const b = await submittedBooking('rep');
      const res = await report(b.token, b.bookingId, '75000', { transactionRef: `TX-${runId}-1`, note: 'Meezan transfer' }).expect(201);
      expect(res.body).toMatchObject({ status: 'AWAITING_VERIFICATION', amount: '75000.00', purpose: 'DEPOSIT', method: 'BANK_TRANSFER', transactionRef: `TX-${runId}-1` });
      expect(res.body.reference).toMatch(/^PAY-\d{4}-\d{6}$/);
      const row = await booking(b.bookingId);
      expect(row.amountPaid.toString()).toBe('0');
      expect(row.paymentStatus).toBe('UNPAID');
      expect(row.status).toBe('PENDING_PAYMENT');
      const money = (await call('get', `/me/bookings/${b.bookingId}/money`, { token: b.token }).expect(200)).body;
      expect(money).toMatchObject({ amountPaid: '0.00', balanceDue: '300000.00', payable: '225000.00' }); // the claimed 75,000 is set aside
    });

    it('refuses overpayment, duplicates, bad input and other peoples bookings', async () => {
      const b = await submittedBooking('rep-bad');
      expect((await report(b.token, b.bookingId, '300000.01').expect(422)).body.code).toBe('overpayment');
      await report(b.token, b.bookingId, '1000', { transactionRef: `DUP-${runId}` }).expect(201);
      expect((await report(b.token, b.bookingId, '1000', { transactionRef: `DUP-${runId}` }).expect(409)).body.code).toBe('duplicate_payment');
      await report(b.token, b.bookingId, '-5').expect(400);
      await report(b.token, b.bookingId, '100', { method: 'CARD' }).expect(400);
      await report(b.token, b.bookingId, '100', { paidOn: '2999-01-01' }).expect(400);
      const other = await customer('rep-other');
      await report(other.token, b.bookingId, '100').expect(404);
    });

    it('cannot pay for an unsubmitted or cancelled booking', async () => {
      const c = await customer('rep-state');
      const pkg = await prisma.package.create({
        data: { slug: `e2e-fin-state-${runId}`, title: 'E2E Finance State', durationDays: 10, status: 'PUBLISHED', publishedAt: new Date(), departures: { create: { departureDate: day(60), returnDate: day(70), seatsTotal: 5, status: 'OPEN', prices: { create: [{ occupancy: 'DOUBLE', adultPrice: '1000.00' }] } } } },
        include: { departures: true },
      });
      packageIds.push(pkg.id);
      const draft = (await call('post', '/me/bookings', { token: c.token, body: { departureId: pkg.departures[0]!.id, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(201)).body;
      expect((await report(c.token, draft.id, '100').expect(409)).body.code).toBe('not_payable');
      await call('post', `/me/bookings/${draft.id}/cancel`, { token: c.token, body: {} }).expect(200);
      expect((await report(c.token, draft.id, '100').expect(409)).body.code).toBe('not_payable');
    });
  });

  /* ------------------------------ verification ------------------------------ */

  describe('verification', () => {
    it('verifying the deposit confirms the booking, updates balances and the invoice, and emails the customer', async () => {
      const b = await submittedBooking('ver');
      const fin = await staff('ver-fin', 'FINANCE_OFFICER');
      const p = (await report(b.token, b.bookingId, '75000', { transactionRef: `V-${runId}` }).expect(201)).body;
      mailer.sent.length = 0;

      const done = await call('post', `/admin/payments/${p.id}/verify`, { token: fin.token, body: { decision: 'APPROVE' } }).expect(200);
      expect(done.body).toMatchObject({ status: 'SUCCESSFUL', verifiedByName: 'Staff ver-fin' });
      const row = await booking(b.bookingId);
      expect(row).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'DEPOSIT_PAID' });
      expect(row.amountPaid.toString()).toBe('75000');
      expect(row.balanceDue.toString()).toBe('225000');
      expect(mailer.sent.find((m) => m.template === 'booking.confirmed')?.vars.reference).toBe(b.reference);
      const history = await prisma.bookingStatusHistory.findMany({ where: { bookingId: b.bookingId }, orderBy: { createdAt: 'asc' } });
      expect(history.at(-1)).toMatchObject({ toStatus: 'CONFIRMED', note: 'Deposit received' });
      const inv = (await call('get', '/me/invoices', { token: b.token }).expect(200)).body[0];
      expect(inv).toMatchObject({ status: 'PARTIALLY_PAID', amountPaid: '75000.00', balanceDue: '225000.00' });

      // Deciding twice is refused.
      expect((await call('post', `/admin/payments/${p.id}/verify`, { token: fin.token, body: { decision: 'APPROVE' } }).expect(409)).body.code).toBe('already_decided');

      // Paying the rest settles everything.
      const rest = (await report(b.token, b.bookingId, '225000').expect(201)).body;
      expect(rest.purpose).toBe('BALANCE');
      await call('post', `/admin/payments/${rest.id}/verify`, { token: fin.token, body: { decision: 'APPROVE' } }).expect(200);
      expect(await booking(b.bookingId)).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' });
      expect((await call('get', '/me/invoices', { token: b.token }).expect(200)).body[0]).toMatchObject({ status: 'PAID', balanceDue: '0.00' });
      expect(await prisma.auditLog.count({ where: { entityId: p.id, action: 'payment.verified' } })).toBe(1);
    });

    it('rejecting needs a reason and leaves the booking unpaid', async () => {
      const b = await submittedBooking('rej');
      const fin = await staff('rej-fin', 'FINANCE_OFFICER');
      const p = (await report(b.token, b.bookingId, '75000').expect(201)).body;
      await call('post', `/admin/payments/${p.id}/verify`, { token: fin.token, body: { decision: 'REJECT' } }).expect(400);
      const res = await call('post', `/admin/payments/${p.id}/verify`, { token: fin.token, body: { decision: 'REJECT', note: 'No such transfer on the statement' } }).expect(200);
      expect(res.body).toMatchObject({ status: 'FAILED', failureMessage: 'No such transfer on the statement' });
      expect(await booking(b.bookingId)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' });
      // The customer sees why, and the amount is available to pay again.
      expect((await call('get', `/me/payments/${p.id}`, { token: b.token }).expect(200)).body.failureMessage).toBe('No such transfer on the statement');
      expect((await call('get', `/me/bookings/${b.bookingId}/money`, { token: b.token }).expect(200)).body.payable).toBe('300000.00');
    });

    it('only finance can verify; concurrent verification counts a payment once', async () => {
      const b = await submittedBooking('race');
      const fin1 = await staff('race-fin1', 'FINANCE_OFFICER');
      const fin2 = await staff('race-fin2', 'FINANCE_OFFICER');
      const sales = await staff('race-sales', 'SALES_AGENT');
      const manager = await staff('race-mgr', 'BOOKING_MANAGER');
      const p = (await report(b.token, b.bookingId, '75000').expect(201)).body;
      await call('post', `/admin/payments/${p.id}/verify`, { token: b.token, body: { decision: 'APPROVE' } }).expect(403);
      await call('post', `/admin/payments/${p.id}/verify`, { token: sales.token, body: { decision: 'APPROVE' } }).expect(403);
      await call('post', `/admin/payments/${p.id}/verify`, { token: manager.token, body: { decision: 'APPROVE' } }).expect(403); // may read payments, not verify them
      const results = await Promise.all([
        call('post', `/admin/payments/${p.id}/verify`, { token: fin1.token, body: { decision: 'APPROVE' } }),
        call('post', `/admin/payments/${p.id}/verify`, { token: fin2.token, body: { decision: 'APPROVE' } }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await booking(b.bookingId)).amountPaid.toString()).toBe('75000'); // not 150000
    });
  });

  /* ------------------------------ staff recording ------------------------------ */

  describe('staff recording', () => {
    it('counts at once for finance, waits for a second person otherwise, and never lets you verify your own entry', async () => {
      const b = await submittedBooking('rec');
      const fin = await staff('rec-fin', 'FINANCE_OFFICER');
      const admin = await staff('rec-admin', 'SUPER_ADMIN');
      const body = { bookingId: b.bookingId, method: 'CASH', amount: '30000', paidOn: today(), note: 'Paid at the office' };

      const counted = await call('post', '/admin/payments', { token: fin.token, body }).expect(201);
      expect(counted.body).toMatchObject({ status: 'SUCCESSFUL', method: 'CASH', recordedByName: 'Staff rec-fin' });
      expect(await booking(b.bookingId)).toMatchObject({ paymentStatus: 'PARTIALLY_PAID', status: 'PENDING_PAYMENT' });

      // A booking manager has no payments:create, so cannot record at all.
      const manager = await staff('rec-mgr', 'BOOKING_MANAGER');
      await call('post', '/admin/payments', { token: manager.token, body }).expect(403);

      // Reaching the deposit with a recorded payment confirms the booking.
      await call('post', '/admin/payments', { token: admin.token, body: { ...body, amount: '45000', method: 'BANK_TRANSFER' } }).expect(201);
      expect(await booking(b.bookingId)).toMatchObject({ paymentStatus: 'DEPOSIT_PAID', status: 'CONFIRMED' });

      expect((await call('post', '/admin/payments', { token: fin.token, body: { ...body, amount: '999999' } }).expect(422)).body.code).toBe('overpayment');
    });

    it('lists and filters payments for finance', async () => {
      const b = await submittedBooking('list');
      const fin = await staff('list-fin', 'FINANCE_OFFICER');
      const sales = await staff('list-sales', 'SALES_AGENT');
      const p = (await report(b.token, b.bookingId, '5000').expect(201)).body;
      const found = await call('get', `/admin/payments?q=${p.reference}&status=AWAITING_VERIFICATION`, { token: fin.token }).expect(200);
      expect(found.body.items.map((i: { id: string }) => i.id)).toEqual([p.id]);
      await call('get', '/admin/payments', { token: sales.token }).expect(403);
      await call('get', '/admin/payments', { token: b.token }).expect(403);
      const fb = (await call('get', `/admin/bookings/${b.bookingId}/finance`, { token: fin.token }).expect(200)).body;
      expect(fb.payments).toHaveLength(1);
      expect(fb.invoices).toHaveLength(1);
      expect(fb.money).toMatchObject({ currency: 'PKR', grandTotal: '300000.00' });
    });
  });

  /* ------------------------------ refunds ------------------------------ */

  describe('refunds', () => {
    async function paidBooking(tag: string) {
      const b = await submittedBooking(tag);
      const fin = await staff(`${tag}-fin`, 'FINANCE_OFFICER');
      const p = (await call('post', '/admin/payments', { token: fin.token, body: { bookingId: b.bookingId, method: 'BANK_TRANSFER', amount: '100000', paidOn: today() } }).expect(201)).body;
      return { ...b, fin, payment: p as { id: string } };
    }

    it('follows request, a second persons approval, then payment, and updates every balance', async () => {
      const b = await paidBooking('ref');
      const approver = await staff('ref-approver', 'SUPER_ADMIN');
      expect(await booking(b.bookingId)).toMatchObject({ paymentStatus: 'DEPOSIT_PAID' });

      const r = (await call('post', '/admin/refunds', { token: b.fin.token, body: { paymentId: b.payment.id, amount: '40000', reason: 'Customer reduced travelers' } }).expect(201)).body;
      expect(r).toMatchObject({ status: 'REQUESTED', amount: '40000.00' });
      expect((await call('post', `/admin/refunds/${r.id}/action`, { token: b.fin.token, body: { action: 'approve' } }).expect(409)).body.code).toBe('same_person');
      expect((await call('post', `/admin/refunds/${r.id}/action`, { token: approver.token, body: { action: 'complete' } }).expect(409)).body.code).toBe('invalid_state');
      expect((await call('post', `/admin/refunds/${r.id}/action`, { token: approver.token, body: { action: 'approve' } }).expect(200)).body.status).toBe('APPROVED');
      // Approved is not paid: the booking is untouched until the money has actually gone out.
      expect((await booking(b.bookingId)).amountRefunded.toString()).toBe('0');
      const done = await call('post', `/admin/refunds/${r.id}/action`, { token: approver.token, body: { action: 'complete', note: 'Bank ref RF-1' } }).expect(200);
      expect(done.body).toMatchObject({ status: 'COMPLETED', approvedByName: 'Staff ref-approver' });
      const row = await booking(b.bookingId);
      expect(row.amountRefunded.toString()).toBe('40000');
      expect(row.balanceDue.toString()).toBe('240000'); // 300000 - (100000 - 40000)
      expect(row.paymentStatus).toBe('PARTIALLY_PAID'); // 60000 held is below the 75000 deposit
      expect((await call('get', `/admin/payments?bookingId=${b.bookingId}`, { token: b.fin.token }).expect(200)).body.items[0]).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedAmount: '40000.00' });
      await call('post', `/admin/refunds/${r.id}/action`, { token: approver.token, body: { action: 'complete' } }).expect(409); // only once
    });

    it('cannot refund more than was paid, in total', async () => {
      const b = await paidBooking('over');
      const r1 = (await call('post', '/admin/refunds', { token: b.fin.token, body: { paymentId: b.payment.id, amount: '70000', reason: 'First' } }).expect(201)).body;
      expect((await call('post', '/admin/refunds', { token: b.fin.token, body: { paymentId: b.payment.id, amount: '30000.01', reason: 'Second' } }).expect(422)).body.code).toBe('over_refund');
      await call('post', '/admin/refunds', { token: b.fin.token, body: { paymentId: b.payment.id, amount: '30000', reason: 'Second' } }).expect(201);
      expect(r1.status).toBe('REQUESTED');
      // A rejected refund frees its amount again.
      const approver = await staff('over-approver', 'SUPER_ADMIN');
      await call('post', `/admin/refunds/${r1.id}/action`, { token: approver.token, body: { action: 'reject' } }).expect(400);
      await call('post', `/admin/refunds/${r1.id}/action`, { token: approver.token, body: { action: 'reject', note: 'Not eligible' } }).expect(200);
      await call('post', '/admin/refunds', { token: b.fin.token, body: { paymentId: b.payment.id, amount: '70000', reason: 'Again' } }).expect(201);
    });

    it('cancelling a paid booking holds the money as refund pending until it is returned', async () => {
      const b = await paidBooking('cancel');
      const manager = await staff('cancel-mgr', 'BOOKING_MANAGER');
      const approver = await staff('cancel-approver', 'SUPER_ADMIN');
      await call('post', `/admin/bookings/${b.bookingId}/status`, { token: manager.token, body: { toStatus: 'CANCELLED', note: 'Customer cancelled' } }).expect(200);
      expect(await booking(b.bookingId)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUND_PENDING' });
      expect((await booking(b.bookingId)).balanceDue.toString()).toBe('0');
      expect((await call('get', '/me/invoices', { token: b.token }).expect(200)).body[0].status).not.toBe('VOID'); // money was paid, so the invoice stays on record
      expect((await report(b.token, b.bookingId, '100').expect(409)).body.code).toBe('not_payable');

      const r = (await call('post', '/admin/refunds', { token: b.fin.token, body: { paymentId: b.payment.id, amount: '100000', reason: 'Full refund on cancellation' } }).expect(201)).body;
      await call('post', `/admin/refunds/${r.id}/action`, { token: approver.token, body: { action: 'approve' } }).expect(200);
      await call('post', `/admin/refunds/${r.id}/action`, { token: approver.token, body: { action: 'complete' } }).expect(200);
      expect(await booking(b.bookingId)).toMatchObject({ paymentStatus: 'REFUNDED' });
      expect((await call('get', '/me/invoices', { token: b.token }).expect(200)).body[0]).toMatchObject({ status: 'REFUNDED' });
    });

    it('voids the invoice of an unpaid booking when it is cancelled', async () => {
      const b = await submittedBooking('void-auto');
      await call('post', `/me/bookings/${b.bookingId}/cancel`, { token: b.token, body: {} }).expect(200);
      const inv = (await call('get', '/me/invoices', { token: b.token }).expect(200)).body[0];
      expect(inv).toMatchObject({ status: 'VOID', voidReason: 'Booking cancelled' });
    });
  });

  /* ------------------------------ manual invoice operations ------------------------------ */

  describe('invoice administration', () => {
    it('voids an unpaid invoice, reissues, and refuses to void a paid one', async () => {
      const b = await submittedBooking('invadm');
      const fin = await staff('invadm-fin', 'FINANCE_OFFICER');
      const sales = await staff('invadm-sales', 'SALES_AGENT');
      const inv = (await call('get', `/admin/bookings/${b.bookingId}/finance`, { token: fin.token }).expect(200)).body.invoices[0];
      await call('post', `/admin/invoices/${inv.id}/void`, { token: sales.token, body: { reason: 'x' } }).expect(403);
      await call('post', `/admin/invoices/${inv.id}/void`, { token: fin.token, body: { reason: '' } }).expect(400);
      expect((await call('post', `/admin/invoices/${inv.id}/void`, { token: fin.token, body: { reason: 'Wrong name' } }).expect(200)).body).toMatchObject({ status: 'VOID', voidReason: 'Wrong name' });
      const again = (await call('post', `/admin/bookings/${b.bookingId}/invoice`, { token: fin.token }).expect(201)).body;
      expect(again.id).not.toBe(inv.id);
      expect(again.status).toBe('ISSUED');
      // Issuing again returns the live one rather than duplicating.
      expect((await call('post', `/admin/bookings/${b.bookingId}/invoice`, { token: fin.token }).expect(201)).body.id).toBe(again.id);

      await call('post', '/admin/payments', { token: fin.token, body: { bookingId: b.bookingId, method: 'CASH', amount: '75000', paidOn: today() } }).expect(201);
      expect((await call('post', `/admin/invoices/${again.id}/void`, { token: fin.token, body: { reason: 'Mistake' } }).expect(409)).body.code).toBe('has_payments');
      const listed = await call('get', `/admin/invoices?q=${again.number}`, { token: fin.token }).expect(200);
      expect(listed.body.items[0]).toMatchObject({ number: again.number, status: 'PARTIALLY_PAID' });
    });
  });
});
