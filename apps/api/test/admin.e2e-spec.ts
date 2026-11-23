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

type Method = 'get' | 'post' | 'put' | 'delete';

describe('Admin portal API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const mailer = new CapturingMailer();
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const packageIds: string[] = [];
  let ipCounter = 0;
  let stepOffset = 0;
  const freshIp = () => `10.78.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;

  const call = (method: Method, url: string, opts: { body?: object; token?: string } = {}) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`).set('x-internal-key', INTERNAL_KEY).set('x-client-ip', freshIp());
    if (opts.token) r = r.set('Authorization', `Bearer ${opts.token}`);
    return opts.body ? r.send(opts.body) : r;
  };

  async function customer(tag: string) {
    const email = `e2e-admin-${tag}-${runId}@example.com`;
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
    const email = `e2e-admin-staff-${tag}-${runId}@example.com`;
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
    const code = totpAt(secret, Date.now() + (stepOffset++ % 2) * 0);
    const second = await call('post', '/auth/2fa/verify', { body: { challengeToken: first.body.challengeToken, code } }).expect(200);
    return { id: user.id, email, token: second.body.tokens.accessToken as string };
  }

  async function departure(tag: string, seats: number) {
    const pkg = await prisma.package.create({
      data: {
        slug: `e2e-admin-${tag}-${runId}`,
        title: `E2E Admin ${tag}`,
        durationDays: 14,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        depositType: 'PERCENTAGE',
        depositValue: 25,
        departures: {
          create: { departureDate: day(60), returnDate: day(74), seatsTotal: seats, status: 'OPEN', prices: { create: [{ occupancy: 'DOUBLE', adultPrice: '300000.00' }] } },
        },
      },
      include: { departures: true },
    });
    packageIds.push(pkg.id);
    return { packageId: pkg.id, departureId: pkg.departures[0]!.id };
  }

  /** A customer with a submitted booking (travelers saved, passport present), ready for staff to handle. */
  async function submittedBooking(tag: string, seats = 10) {
    const c = await customer(tag);
    const d = await departure(tag, seats);
    const b = (await call('post', '/me/bookings', { token: c.token, body: { departureId: d.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(201)).body;
    const t = (
      await call('post', '/me/travelers', {
        token: c.token,
        body: { firstName: 'Ali', lastName: tag, gender: 'MALE', dateOfBirth: '1980-01-01', nationality: 'PK', passportNumber: `PP${runId.toUpperCase().slice(0, 6)}${tag.length}`.slice(0, 9).padEnd(7, '0'), passportExpiryDate: ymd(day(1200)) },
      }).expect(201)
    ).body;
    await call('put', `/me/bookings/${b.id}/travelers`, { token: c.token, body: { leadTravelerId: t.id, assignments: [{ roomIndex: 0, travelerId: t.id }] } }).expect(200);
    await call('post', `/me/bookings/${b.id}/submit`, { token: c.token }).expect(200);
    return { ...c, ...d, bookingId: b.id as string, reference: b.reference as string, travelerId: t.id as string };
  }

  const seats = async (departureId: string) => (await prisma.packageDeparture.findUniqueOrThrow({ where: { id: departureId } })).seatsReserved;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailerService).useValue(mailer).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ENV));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const owned = { OR: [{ booking: { customerId: { in: customerIds } } }, { booking: { packageId: { in: packageIds } } }] };
    await prisma.refund.deleteMany({ where: owned });
    await prisma.payment.deleteMany({ where: owned });
    await prisma.invoice.deleteMany({ where: owned });
    await prisma.booking.deleteMany({ where: { OR: [{ customerId: { in: customerIds } }, { packageId: { in: packageIds } }] } });
    await prisma.traveler.deleteMany({ where: { customerId: { in: customerIds } } });
    const extra = await prisma.package.findMany({ where: { slug: { startsWith: `e2e-admin-pkg-${runId}` } }, select: { id: true } });
    const all = [...packageIds, ...extra.map((p) => p.id)];
    await prisma.packageDeparture.deleteMany({ where: { packageId: { in: all } } });
    await prisma.package.deleteMany({ where: { id: { in: all } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { status: 'DEACTIVATED', deletedAt: new Date() } });
    await prisma.session.updateMany({ where: { userId: { in: userIds }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'test_cleanup' } });
    await app?.close();
  });

  /* ------------------------------ access control ------------------------------ */

  describe('access control', () => {
    it('keeps customers and anonymous callers out, and limits staff to their permissions', async () => {
      const c = await customer('rbac');
      const sales = await staff('sales', 'SALES_AGENT');
      const finance = await staff('fin', 'FINANCE_OFFICER');
      for (const url of ['/admin/dashboard', '/admin/bookings', '/admin/customers', '/admin/packages']) {
        await call('get', url).expect(401);
        await call('get', url, { token: c.token }).expect(403);
      }
      await call('get', '/admin/dashboard', { token: sales.token }).expect(200);
      await call('get', '/admin/bookings', { token: sales.token }).expect(200);
      await call('get', '/admin/customers', { token: sales.token }).expect(200);
      // Sales agents read the catalogue but cannot change it.
      await call('get', '/admin/packages', { token: sales.token }).expect(200);
      await call('post', '/admin/packages', { token: sales.token, body: {} }).expect(403);
      await call('get', '/admin/packages', { token: finance.token }).expect(403);
    });
  });

  /* ------------------------------ bookings ------------------------------ */

  describe('bookings', () => {
    it('lists, filters and shows a booking with masked identity numbers', async () => {
      const b = await submittedBooking('list');
      const admin = await staff('list-admin', 'SUPER_ADMIN');
      const found = await call('get', `/admin/bookings?q=${b.reference}`, { token: admin.token }).expect(200);
      expect(found.body.items).toHaveLength(1);
      expect(found.body.items[0]).toMatchObject({ id: b.bookingId, status: 'PENDING_PAYMENT', customerEmail: b.email });
      const none = await call('get', `/admin/bookings?q=${b.reference}&status=CONFIRMED`, { token: admin.token }).expect(200);
      expect(none.body.items).toHaveLength(0);
      await call('get', '/admin/bookings?status=NOT_A_STATUS', { token: admin.token }).expect(400);

      const detail = (await call('get', `/admin/bookings/${b.bookingId}`, { token: admin.token }).expect(200)).body;
      expect(detail.customer.email).toBe(b.email);
      expect(detail.allowedTransitions).toEqual(['CONFIRMED', 'CANCELLED']);
      expect(detail.staffTravelers).toHaveLength(1);
      expect(detail.staffTravelers[0].passportNumberMasked).toMatch(/^\*+\w{4}$/);
      expect(JSON.stringify(detail)).not.toMatch(/passportNumberEnc|passportNumberHash/);
      await call('get', '/admin/bookings/00000000-0000-4000-8000-000000000000', { token: admin.token }).expect(404);
    });

    it('moves a booking through the workflow, enforcing rules and recording history', async () => {
      const b = await submittedBooking('flow');
      const manager = await staff('flow-mgr', 'BOOKING_MANAGER');
      const sales = await staff('flow-sales', 'SALES_AGENT');
      mailer.sent.length = 0;

      await call('post', `/admin/bookings/${b.bookingId}/status`, { token: sales.token, body: { toStatus: 'CONFIRMED' } }).expect(403);
      expect((await call('post', `/admin/bookings/${b.bookingId}/status`, { token: manager.token, body: { toStatus: 'COMPLETED' } }).expect(422)).body.code).toBe('invalid_transition');
      expect((await call('post', `/admin/bookings/${b.bookingId}/status`, { token: manager.token, body: { toStatus: 'PENDING_PAYMENT' } }).expect(409)).body.code).toBe('no_change');

      const confirmed = await call('post', `/admin/bookings/${b.bookingId}/status`, { token: manager.token, body: { toStatus: 'CONFIRMED', note: 'Deposit received by bank transfer' } }).expect(200);
      expect(confirmed.body.status).toBe('CONFIRMED');
      expect(confirmed.body.allowedTransitions).toEqual(['VISA_PROCESSING', 'CANCELLED']);
      expect(confirmed.body.history.at(-1)).toMatchObject({ status: 'CONFIRMED', note: 'Deposit received by bank transfer' });
      expect(mailer.sent.find((m) => m.template === 'booking.confirmed')).toMatchObject({ to: b.email, vars: { reference: b.reference } });
      // Confirming by hand does not pretend money arrived.
      expect(confirmed.body.paymentStatus).toBe('UNPAID');

      await call('post', `/admin/bookings/${b.bookingId}/status`, { token: manager.token, body: { toStatus: 'VISA_PROCESSING' } }).expect(200);
      const actions = (await prisma.auditLog.findMany({ where: { entityId: b.bookingId, action: 'booking.status_changed' } })).length;
      expect(actions).toBe(2);
      // The customer sees the new status.
      expect((await call('get', `/me/bookings/${b.bookingId}`, { token: b.token }).expect(200)).body.status).toBe('VISA_PROCESSING');
    });

    it('cancelling needs a reason and returns the seats exactly once', async () => {
      const b = await submittedBooking('cancel');
      const manager = await staff('cancel-mgr', 'BOOKING_MANAGER');
      expect(await seats(b.departureId)).toBe(1);
      expect((await call('post', `/admin/bookings/${b.bookingId}/status`, { token: manager.token, body: { toStatus: 'CANCELLED' } }).expect(422)).body.code).toBe('note_required');
      const res = await call('post', `/admin/bookings/${b.bookingId}/status`, { token: manager.token, body: { toStatus: 'CANCELLED', note: 'Customer asked by phone' } }).expect(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Customer asked by phone', allowedTransitions: [] });
      expect(await seats(b.departureId)).toBe(0);
      await call('post', `/admin/bookings/${b.bookingId}/status`, { token: manager.token, body: { toStatus: 'CANCELLED', note: 'again' } }).expect(409);
      expect(await seats(b.departureId)).toBe(0);
    });

    it('does not let two staff change the same booking at once', async () => {
      const b = await submittedBooking('race');
      const m1 = await staff('race-1', 'BOOKING_MANAGER');
      const m2 = await staff('race-2', 'BOOKING_MANAGER');
      const results = await Promise.all([
        call('post', `/admin/bookings/${b.bookingId}/status`, { token: m1.token, body: { toStatus: 'CANCELLED', note: 'one' } }),
        call('post', `/admin/bookings/${b.bookingId}/status`, { token: m2.token, body: { toStatus: 'CANCELLED', note: 'two' } }),
      ]);
      const codes = results.map((r) => r.status).sort();
      expect(codes[0]).toBe(200); // exactly one wins; the other is refused as a conflict or as an invalid move
      expect([409, 422]).toContain(codes[1]);
      expect(await seats(b.departureId)).toBe(0); // released once, never negative
    });

    it('assigns bookings to active staff and keeps notes', async () => {
      const b = await submittedBooking('assign');
      const manager = await staff('assign-mgr', 'BOOKING_MANAGER');
      const sales = await staff('assign-sales', 'SALES_AGENT');
      await call('post', `/admin/bookings/${b.bookingId}/assign`, { token: sales.token, body: { assignedToId: manager.id } }).expect(403);
      const assigned = await call('post', `/admin/bookings/${b.bookingId}/assign`, { token: manager.token, body: { assignedToId: manager.id } }).expect(200);
      expect(assigned.body.assignedToId).toBe(manager.id);
      expect((await call('post', `/admin/bookings/${b.bookingId}/assign`, { token: manager.token, body: { assignedToId: b.customerId } }).expect(422)).body.code).toBe('invalid_assignee');
      const mine = await call('get', `/admin/bookings?assignedToId=${manager.id}`, { token: manager.token }).expect(200);
      expect(mine.body.items.map((i: { id: string }) => i.id)).toContain(b.bookingId);

      const noted = await call('post', `/admin/bookings/${b.bookingId}/notes`, { token: manager.token, body: { body: 'Called customer, will pay Friday.' } }).expect(201);
      expect(noted.body.notes[0]).toMatchObject({ body: 'Called customer, will pay Friday.', authorName: 'Staff assign-mgr' });
      await call('post', `/admin/bookings/${b.bookingId}/notes`, { token: manager.token, body: { body: '   ' } }).expect(400);
      await call('post', `/admin/bookings/${b.bookingId}/notes`, { token: sales.token, body: { body: 'x' } }).expect(403);
      // Staff notes are never shown to customers.
      expect(JSON.stringify((await call('get', `/me/bookings/${b.bookingId}`, { token: b.token }).expect(200)).body)).not.toContain('will pay Friday');
    });
  });

  /* ------------------------------ customers ------------------------------ */

  describe('customers', () => {
    it('searches customers and shows their bookings and travelers', async () => {
      const b = await submittedBooking('cust');
      const sales = await staff('cust-sales', 'SALES_AGENT');
      const list = await call('get', `/admin/customers?q=${encodeURIComponent(b.email)}`, { token: sales.token }).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: b.customerId, hasAccount: true, bookings: 1 });
      const detail = (await call('get', `/admin/customers/${b.customerId}`, { token: sales.token }).expect(200)).body;
      expect(detail.bookings[0].reference).toBe(b.reference);
      expect(detail.travelers[0].passportNumberMasked).toMatch(/^\*+\w{4}$/);
      const noted = await call('post', `/admin/customers/${b.customerId}/notes`, { token: sales.token, body: { body: 'Prefers WhatsApp' } }).expect(201);
      expect(noted.body.notes[0].body).toBe('Prefers WhatsApp');
    });
  });

  /* ------------------------------ catalogue ------------------------------ */

  describe('packages and departures', () => {
    const pkgInput = (slug: string) => ({
      title: 'E2E Admin Package',
      slug,
      subtitle: 'Test',
      tier: 'STANDARD',
      durationDays: 10,
      nightsMakkah: 5,
      nightsMadinah: 4,
      departureCities: 'Karachi\nLahore',
      mealPlan: 'BREAKFAST',
      inclusions: 'Visa\nHotels',
      exclusions: 'Personal expenses',
      visaIncluded: true,
      flightIncluded: false,
      transportIncluded: true,
      ziyaratIncluded: false,
      depositType: 'PERCENTAGE',
      depositValue: '25',
      isFeatured: false,
    });
    const departureInput = (over: Record<string, unknown> = {}) => ({
      departureDate: ymd(day(90)),
      returnDate: ymd(day(104)),
      departureCity: 'Karachi',
      seatsTotal: 20,
      status: 'OPEN',
      prices: [{ occupancy: 'DOUBLE', adultPrice: '320000', childPrice: '250000' }, { occupancy: 'QUAD', adultPrice: '280000' }],
      ...over,
    });

    it('builds a package, blocks publishing until it can be sold, then goes live on the public site', async () => {
      const admin = await staff('cat-admin', 'SUPER_ADMIN');
      const content = await staff('cat-content', 'CONTENT_MANAGER');
      const slug = `e2e-admin-pkg-${runId}-a`;

      expect((await call('post', '/admin/packages', { token: admin.token, body: { ...pkgInput(slug), nightsMakkah: 9 } }).expect(400)).body.errors.length).toBeGreaterThan(0);
      const created = (await call('post', '/admin/packages', { token: content.token, body: pkgInput(slug) }).expect(201)).body;
      expect(created).toMatchObject({ status: 'DRAFT', slug, departureCities: ['Karachi', 'Lahore'], publishBlockers: [expect.stringMatching(/departure/i)] });
      expect((await call('post', '/admin/packages', { token: admin.token, body: pkgInput(slug) }).expect(409)).body.code).toBe('slug_taken');
      await call('get', `/public/packages/${slug}`).expect(404); // drafts are invisible

      expect((await call('post', `/admin/packages/${created.id}/status`, { token: admin.token, body: { status: 'PUBLISHED' } }).expect(422)).body.code).toBe('publish_blocked');
      // Bad departures are refused.
      await call('post', `/admin/packages/${created.id}/departures`, { token: admin.token, body: departureInput({ returnDate: ymd(day(80)) }) }).expect(400);
      await call('post', `/admin/packages/${created.id}/departures`, { token: admin.token, body: departureInput({ prices: [{ occupancy: 'DOUBLE', adultPrice: '1' }, { occupancy: 'DOUBLE', adultPrice: '2' }] }) }).expect(400);

      const withDeparture = (await call('post', `/admin/packages/${created.id}/departures`, { token: admin.token, body: departureInput() }).expect(201)).body;
      expect(withDeparture.departures[0].prices.map((p: { occupancy: string; adultPrice: string }) => `${p.occupancy}:${p.adultPrice}`).sort()).toEqual(['DOUBLE:320000.00', 'QUAD:280000.00']);
      expect(withDeparture.startingPrice).toBe('280000.00');
      expect(withDeparture.publishBlockers).toEqual([]);

      // Content managers can publish; sales agents cannot.
      const sales = await staff('cat-sales', 'SALES_AGENT');
      await call('post', `/admin/packages/${created.id}/status`, { token: sales.token, body: { status: 'PUBLISHED' } }).expect(403);
      const live = (await call('post', `/admin/packages/${created.id}/status`, { token: content.token, body: { status: 'PUBLISHED' } }).expect(200)).body;
      expect(live.status).toBe('PUBLISHED');
      const pub = await call('get', `/public/packages/${slug}`).expect(200);
      expect(pub.body.title).toBe('E2E Admin Package');

      // The web address is locked once the package is live.
      expect((await call('put', `/admin/packages/${created.id}`, { token: admin.token, body: { ...pkgInput(`${slug}-renamed`) } }).expect(409)).body.code).toBe('slug_locked');
      const edited = await call('put', `/admin/packages/${created.id}`, { token: admin.token, body: { ...pkgInput(slug), title: 'E2E Admin Package v2', depositValue: '30' } }).expect(200);
      expect(edited.body).toMatchObject({ title: 'E2E Admin Package v2', depositValue: '30.00' });

      await call('post', `/admin/packages/${created.id}/status`, { token: admin.token, body: { status: 'ARCHIVED' } }).expect(200);
      await call('get', `/public/packages/${slug}`).expect(404);
      const audit = (await prisma.auditLog.findMany({ where: { entityId: created.id } })).map((a) => a.action);
      expect(audit).toEqual(expect.arrayContaining(['package.created', 'package.published', 'package.updated', 'package.archived']));
    });

    it('protects departures that have bookings', async () => {
      const b = await submittedBooking('dep', 5);
      const admin = await staff('dep-admin', 'SUPER_ADMIN');
      const pkg = (await call('get', `/admin/packages/${b.packageId}`, { token: admin.token }).expect(200)).body;
      const dep = pkg.departures[0];
      expect(dep).toMatchObject({ seatsReserved: 1, bookings: 1 });

      expect((await call('put', `/admin/packages/${b.packageId}/departures/${dep.id}`, { token: admin.token, body: departureInput({ departureDate: dep.departureDate, returnDate: dep.returnDate, seatsTotal: 0 }) }).expect(400)).body.errors).toBeDefined();
      const priced = await call('put', `/admin/packages/${b.packageId}/departures/${dep.id}`, { token: admin.token, body: departureInput({ departureDate: dep.departureDate, returnDate: dep.returnDate, seatsTotal: 8, prices: [{ occupancy: 'DOUBLE', adultPrice: '350000' }] }) }).expect(200);
      expect(priced.body.departures[0]).toMatchObject({ seatsTotal: 8, seatsReserved: 1 });
      // Raising the price does not change the booking that was already made.
      expect((await call('get', `/me/bookings/${b.bookingId}`, { token: b.token }).expect(200)).body.grandTotal).toBe('300000.00');

      expect((await call('delete', `/admin/packages/${b.packageId}/departures/${dep.id}`, { token: admin.token }).expect(409)).body.code).toBe('departure_has_bookings');
      const empty = (await call('post', `/admin/packages/${b.packageId}/departures`, { token: admin.token, body: departureInput() }).expect(201)).body.departures.find((d: { id: string }) => d.id !== dep.id);
      await call('delete', `/admin/packages/${b.packageId}/departures/${empty.id}`, { token: admin.token }).expect(200);
    });
  });

  /* ------------------------------ dashboard ------------------------------ */

  describe('dashboard', () => {
    it('reports real figures', async () => {
      await submittedBooking('dash');
      const admin = await staff('dash-admin', 'SUPER_ADMIN');
      const s = (await call('get', '/admin/dashboard', { token: admin.token }).expect(200)).body;
      expect(s.bookings.byStatus.PENDING_PAYMENT).toBeGreaterThanOrEqual(1);
      expect(s.bookings.awaitingAction).toBe(s.bookings.byStatus.PENDING_PAYMENT);
      expect(s.customers.total).toBeGreaterThanOrEqual(1);
      expect(s.catalog.openDepartures).toBeGreaterThanOrEqual(1);
      expect(Number(s.revenue.bookedValue)).toBeGreaterThanOrEqual(300000);
      expect(s.recentBookings.length).toBeGreaterThan(0);
      expect(s.recentBookings.every((r: { status: string }) => r.status !== 'DRAFT')).toBe(true);
    });
  });
});
