import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
const INTERNAL_KEY = 'e2e-internal-key-0123456789abcdef';
process.env.INTERNAL_API_KEY = INTERNAL_KEY;
process.env.EMAIL_PROVIDER = 'log';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { configureApp } from '../src/bootstrap';
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

const runId = Date.now().toString(36);
const day = (offset: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + offset));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Date of birth for someone who is `years` old on the departure's return date (~74 days from now). */
const dobFor = (years: number) => ymd(day(74 - Math.round(years * 365.25) - 5));

type Method = 'get' | 'post' | 'put' | 'delete';

describe('Customer portal: profile, travelers and bookings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const mailer = new CapturingMailer();
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const packageIds: string[] = [];
  let ipCounter = 0;
  const freshIp = () => `10.77.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;

  const call = (method: Method, url: string, opts: { body?: object; token?: string } = {}) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`).set('x-internal-key', INTERNAL_KEY).set('x-client-ip', freshIp());
    if (opts.token) r = r.set('Authorization', `Bearer ${opts.token}`);
    return opts.body ? r.send(opts.body) : r;
  };

  async function customer(tag: string) {
    const email = `e2e-portal-${tag}-${runId}@example.com`;
    const passwords = app.get(PasswordService);
    const user = await prisma.user.create({
      data: { email, passwordHash: await passwords.hash('correct horse battery staple'), type: 'CUSTOMER', status: 'ACTIVE', firstName: 'Test', lastName: tag, emailVerifiedAt: new Date() },
    });
    const c = await prisma.customer.create({ data: { userId: user.id, firstName: 'Test', lastName: tag, email } });
    userIds.push(user.id);
    customerIds.push(c.id);
    const login = await call('post', '/auth/login', { body: { email, password: 'correct horse battery staple' } }).expect(200);
    return { userId: user.id, customerId: c.id, email, token: login.body.tokens.accessToken as string };
  }

  /** A published package with one open departure so the tests do not depend on demo data aging. */
  async function fixture(tag: string, seats: number) {
    const pkg = await prisma.package.create({
      data: {
        slug: `e2e-portal-${tag}-${runId}`,
        title: `E2E Package ${tag}`,
        durationDays: 14,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        depositType: 'PERCENTAGE',
        depositValue: 25,
        departures: {
          create: {
            departureDate: day(60),
            returnDate: day(74),
            departureCity: 'Karachi',
            seatsTotal: seats,
            status: 'OPEN',
            prices: {
              create: [
                { occupancy: 'DOUBLE', adultPrice: '300000.00', childPrice: '250000.00', infantPrice: '40000.00' },
                { occupancy: 'QUAD', adultPrice: '260000.00' },
              ],
            },
          },
        },
      },
      include: { departures: true },
    });
    packageIds.push(pkg.id);
    return { packageId: pkg.id, departureId: pkg.departures[0]!.id };
  }

  const seats = async (departureId: string) => (await prisma.packageDeparture.findUniqueOrThrow({ where: { id: departureId } })).seatsReserved;

  const adultInput = (n: string, extra: Record<string, unknown> = {}) => ({
    relationship: 'SELF',
    firstName: n,
    lastName: 'Tester',
    gender: 'MALE',
    dateOfBirth: dobFor(40),
    nationality: 'PK',
    ...extra,
  });
  const withPassport = (no: string) => ({ passportNumber: no, passportExpiryDate: ymd(day(900)), passportIssuingCountry: 'PK' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailerService).useValue(mailer).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ENV));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const owned = { booking: { customerId: { in: customerIds } } };
    await prisma.refund.deleteMany({ where: owned });
    await prisma.payment.deleteMany({ where: owned });
    await prisma.invoice.deleteMany({ where: owned });
    await prisma.booking.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.traveler.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.packageDeparture.deleteMany({ where: { packageId: { in: packageIds } } });
    await prisma.package.deleteMany({ where: { id: { in: packageIds } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { status: 'DEACTIVATED', deletedAt: new Date() } });
    await prisma.session.updateMany({ where: { userId: { in: userIds }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'test_cleanup' } });
    await app?.close();
  });

  /* ------------------------------ access ------------------------------ */

  it('requires a signed-in customer', async () => {
    await call('get', '/me/profile').expect(401);
    await call('get', '/me/bookings').expect(401);
  });

  /* ------------------------------ profile ------------------------------ */

  describe('profile', () => {
    it('reads and updates the profile, keeping the account name in sync', async () => {
      const c = await customer('profile');
      const got = await call('get', '/me/profile', { token: c.token }).expect(200);
      expect(got.body).toMatchObject({ email: c.email, emailVerified: true, whatsappOptIn: false });

      const res = await call('put', '/me/profile', {
        token: c.token,
        body: { firstName: 'Ayesha', lastName: 'Khan', phone: '+92 300 1234567', whatsappNumber: '+92 300 1234567', whatsappOptIn: true, marketingOptIn: false, country: 'pk', city: 'Lahore', preferredLanguage: 'ur' },
      }).expect(200);
      expect(res.body).toMatchObject({ firstName: 'Ayesha', country: 'PK', whatsappOptIn: true, preferredLanguage: 'ur' });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
      expect(user.firstName).toBe('Ayesha');
      const optInAt = (await prisma.customer.findUniqueOrThrow({ where: { id: c.customerId } })).whatsappOptInAt;
      expect(optInAt).not.toBeNull();
      // Opt-in time is kept on later saves and cleared when consent is withdrawn.
      await call('put', '/me/profile', { token: c.token, body: { firstName: 'Ayesha', lastName: 'Khan', whatsappOptIn: true } }).expect(200);
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.customerId } })).whatsappOptInAt?.getTime()).toBe(optInAt?.getTime());
      await call('put', '/me/profile', { token: c.token, body: { firstName: 'Ayesha', lastName: 'Khan', whatsappOptIn: false } }).expect(200);
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.customerId } })).whatsappOptInAt).toBeNull();
    });

    it('rejects invalid input', async () => {
      const c = await customer('profile-bad');
      await call('put', '/me/profile', { token: c.token, body: { firstName: '', lastName: 'X', phone: 'abc' } }).expect(400);
    });
  });

  /* ------------------------------ travelers ------------------------------ */

  describe('travelers', () => {
    it('stores identity numbers encrypted and only returns masked values', async () => {
      const c = await customer('trav');
      const res = await call('post', '/me/travelers', { token: c.token, body: adultInput('Bilal', { ...withPassport('AB1234567'), nationalId: '42101-1234567-1' }) }).expect(201);
      expect(res.body.passportNumberMasked).toBe('*****4567');
      expect(res.body.nationalIdMasked).toBe('***********67-1');
      expect(JSON.stringify(res.body)).not.toContain('AB1234567');

      const row = await prisma.traveler.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.passportNumberEnc).toMatch(/^v1:/);
      expect(row.passportNumberEnc).not.toContain('AB1234567');
      expect(row.passportNumberHash).toHaveLength(64);

      // Editing without retyping the passport keeps it.
      const edited = await call('put', `/me/travelers/${res.body.id}`, { token: c.token, body: adultInput('Bilal', { lastName: 'Renamed', passportExpiryDate: ymd(day(900)) }) }).expect(200);
      expect(edited.body).toMatchObject({ lastName: 'Renamed', passportNumberMasked: '*****4567' });

      const audit = await prisma.auditLog.findFirst({ where: { entityId: res.body.id, action: 'traveler.created' } });
      expect(JSON.stringify(audit?.after)).not.toContain('AB1234567');
    });

    it('refuses duplicates, bad dates and a missing passport expiry', async () => {
      const c = await customer('trav-bad');
      await call('post', '/me/travelers', { token: c.token, body: adultInput('One', withPassport('ZZ9990001')) }).expect(201);
      const dup = await call('post', '/me/travelers', { token: c.token, body: adultInput('Two', withPassport('zz9990001')) }).expect(409);
      expect(dup.body.code).toBe('traveler_duplicate');
      await call('post', '/me/travelers', { token: c.token, body: adultInput('Future', { dateOfBirth: ymd(day(5)) }) }).expect(400);
      await call('post', '/me/travelers', { token: c.token, body: adultInput('NoExpiry', { passportNumber: 'QQ1112223' }) }).expect(400);
    });

    it('keeps one customer out of anothers travelers', async () => {
      const a = await customer('iso-a');
      const b = await customer('iso-b');
      const made = await call('post', '/me/travelers', { token: a.token, body: adultInput('Private') }).expect(201);
      await call('get', `/me/travelers/${made.body.id}`, { token: b.token }).expect(404);
      await call('put', `/me/travelers/${made.body.id}`, { token: b.token, body: adultInput('Hacked') }).expect(404);
      await call('delete', `/me/travelers/${made.body.id}`, { token: b.token }).expect(404);
      expect((await call('get', '/me/travelers', { token: b.token }).expect(200)).body).toEqual([]);
      await call('delete', `/me/travelers/${made.body.id}`, { token: a.token }).expect(204);
      expect((await call('get', '/me/travelers', { token: a.token }).expect(200)).body).toEqual([]);
    });
  });

  /* ------------------------------ quotes ------------------------------ */

  describe('quotes', () => {
    it('prices rooms on the server and validates the room plan', async () => {
      const c = await customer('quote');
      const f = await fixture('quote', 20);
      const ok = await call('post', '/me/bookings/quote', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 2, children: 0, infants: 0 }, { occupancy: 'QUAD', adults: 2, children: 1, infants: 1 }] } }).expect(200);
      // 2x300000 + 2x260000 + child (no child fare -> adult fare) 260000 + infant (no fare -> free)
      expect(ok.body).toMatchObject({ subtotal: '1380000.00', grandTotal: '1380000.00', depositAmount: '345000.00', balanceAmount: '1035000.00', seats: 5, adults: 4, children: 1, infants: 1 });

      const kid = await call('post', '/me/bookings/quote', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 1, infants: 1 }] } }).expect(200);
      expect(kid.body.grandTotal).toBe('590000.00'); // 300000 + 250000 + 40000

      expect((await call('post', '/me/bookings/quote', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 3, children: 0, infants: 0 }] } }).expect(422)).body.code).toBe('room_over_capacity');
      expect((await call('post', '/me/bookings/quote', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 0, children: 2, infants: 0 }] } }).expect(422)).body.code).toBe('room_needs_adult');
      expect((await call('post', '/me/bookings/quote', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'TRIPLE', adults: 1, children: 0, infants: 0 }] } }).expect(422)).body.code).toBe('no_price');
      await call('post', '/me/bookings/quote', { token: c.token, body: { departureId: '00000000-0000-4000-8000-000000000000', rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(404);
    });

    it('refuses closed departures and more seats than remain', async () => {
      const c = await customer('quote-closed');
      const f = await fixture('quote-closed', 2);
      await call('post', '/me/bookings/quote', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'QUAD', adults: 4, children: 0, infants: 0 }] } }).expect(409);
      await prisma.packageDeparture.update({ where: { id: f.departureId }, data: { status: 'CLOSED' } });
      expect((await call('post', '/me/bookings/quote', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(409)).body.code).toBe('departure_closed');
    });
  });

  /* ------------------------------ booking flow ------------------------------ */

  describe('booking lifecycle', () => {
    it('draft -> travelers -> submit -> cancel, with seats held and released', async () => {
      const c = await customer('flow');
      const f = await fixture('flow', 10);
      mailer.sent.length = 0;

      const created = await call('post', '/me/bookings', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'QUAD', adults: 2, children: 1, infants: 0 }], specialRequests: 'Wheelchair at airport' } }).expect(201);
      const id = created.body.id as string;
      expect(created.body).toMatchObject({ status: 'DRAFT', currentStep: 'TRAVELER_DETAILS', grandTotal: '780000.00', depositAmount: '195000.00', travelers: 3 });
      expect(created.body.reference).toMatch(/^UMR-\d{4}-\d{6}$/);
      expect(created.body.seatHoldExpiresAt).not.toBeNull();
      expect(created.body.blockers.length).toBeGreaterThan(0);
      expect(await seats(f.departureId)).toBe(3);

      // Cannot submit before travelers are chosen.
      const early = await call('post', `/me/bookings/${id}/submit`, { token: c.token }).expect(422);
      expect(early.body.code).toBe('booking_incomplete');

      const dad = (await call('post', '/me/travelers', { token: c.token, body: adultInput('Dad') }).expect(201)).body.id as string;
      const mum = (await call('post', '/me/travelers', { token: c.token, body: adultInput('Mum', { gender: 'FEMALE', ...withPassport('MM1000001') }) }).expect(201)).body.id as string;
      const kid = (await call('post', '/me/travelers', { token: c.token, body: adultInput('Kid', { dateOfBirth: dobFor(8), ...withPassport('KK1000001') }) }).expect(201)).body.id as string;

      // Wrong mix (two adults and a child needed; an adult given instead of the child).
      const wrong = await call('put', `/me/bookings/${id}/travelers`, { token: c.token, body: { leadTravelerId: dad, assignments: [{ roomIndex: 0, travelerId: dad }, { roomIndex: 0, travelerId: mum }] } }).expect(422);
      expect(wrong.body.code).toBe('room_mismatch');
      // A child cannot lead.
      await call('put', `/me/bookings/${id}/travelers`, { token: c.token, body: { leadTravelerId: kid, assignments: [{ roomIndex: 0, travelerId: dad }, { roomIndex: 0, travelerId: mum }, { roomIndex: 0, travelerId: kid }] } }).expect(422);

      const assigned = await call('put', `/me/bookings/${id}/travelers`, { token: c.token, body: { leadTravelerId: dad, assignments: [{ roomIndex: 0, travelerId: dad }, { roomIndex: 0, travelerId: mum }, { roomIndex: 0, travelerId: kid }] } }).expect(200);
      expect(assigned.body.currentStep).toBe('PAYMENT');
      expect(assigned.body.travelerList.map((t: { kind: string }) => t.kind).sort()).toEqual(['ADULT', 'ADULT', 'CHILD']);
      expect(assigned.body.travelerList.find((t: { isLead: boolean }) => t.isLead).name).toContain('Dad');
      expect(assigned.body.travelerList.find((t: { kind: string }) => t.kind === 'CHILD').price).toBe('260000.00');
      // Dad has no passport yet.
      expect(assigned.body.blockers.join(' ')).toMatch(/Dad Tester: add passport/);
      expect((await call('post', `/me/bookings/${id}/submit`, { token: c.token }).expect(422)).body.message).toMatch(/passport/);

      await call('put', `/me/travelers/${dad}`, { token: c.token, body: adultInput('Dad', withPassport('DD1000001')) }).expect(200);
      const ready = await call('get', `/me/bookings/${id}`, { token: c.token }).expect(200);
      expect(ready.body.blockers).toEqual([]);

      const submitted = await call('post', `/me/bookings/${id}/submit`, { token: c.token }).expect(200);
      expect(submitted.body).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID', seatHoldExpiresAt: null, canCancel: true });
      expect(submitted.body.balanceDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(submitted.body.history.map((h: { status: string }) => h.status)).toEqual(['DRAFT', 'PENDING_PAYMENT']);
      const sentMail = mailer.sent.find((m) => m.template === 'booking.submitted');
      expect(sentMail?.vars).toMatchObject({ reference: created.body.reference, packageTitle: expect.any(String), amountDue: 'PKR 780000.00' });
      expect(sentMail?.vars.link).toContain(`/account/bookings/${id}`);
      expect(await seats(f.departureId)).toBe(3);

      // Submitted bookings are frozen.
      expect((await call('post', `/me/bookings/${id}/submit`, { token: c.token }).expect(409)).body.code).toBe('not_editable');
      await call('put', `/me/bookings/${id}/travelers`, { token: c.token, body: { leadTravelerId: dad, assignments: [{ roomIndex: 0, travelerId: dad }, { roomIndex: 0, travelerId: mum }, { roomIndex: 0, travelerId: kid }] } }).expect(409);
      expect((await call('put', `/me/travelers/${dad}`, { token: c.token, body: adultInput('Dad', { lastName: 'Changed', ...withPassport('DD1000001') }) }).expect(409)).body.code).toBe('traveler_locked');
      expect((await call('delete', `/me/travelers/${mum}`, { token: c.token }).expect(409)).body.code).toBe('traveler_in_use');

      const list = await call('get', '/me/bookings', { token: c.token }).expect(200);
      expect(list.body.meta.total).toBe(1);
      expect(list.body.items[0]).toMatchObject({ id, status: 'PENDING_PAYMENT' });

      const cancelled = await call('post', `/me/bookings/${id}/cancel`, { token: c.token, body: { reason: 'Plans changed' } }).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Plans changed', canCancel: false });
      expect(await seats(f.departureId)).toBe(0);
      // Idempotent: cancelling again neither errors nor releases seats twice.
      await call('post', `/me/bookings/${id}/cancel`, { token: c.token, body: {} }).expect(200);
      expect(await seats(f.departureId)).toBe(0);

      const actions = (await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
      expect(actions).toEqual(['booking.created', 'booking.travelers_set', 'booking.submitted', 'booking.cancelled']);
      // Travelers are free again once the booking is cancelled.
      await call('delete', `/me/travelers/${mum}`, { token: c.token }).expect(204);
    });

    it('cannot cancel online once money has been received', async () => {
      const c = await customer('paid');
      const f = await fixture('paid', 5);
      const b = (await call('post', '/me/bookings', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(201)).body;
      await prisma.booking.update({ where: { id: b.id }, data: { amountPaid: '1000.00' } });
      expect((await call('post', `/me/bookings/${b.id}/cancel`, { token: c.token, body: {} }).expect(409)).body.code).toBe('contact_support');
    });

    it('keeps bookings private to their owner', async () => {
      const a = await customer('own-a');
      const b = await customer('own-b');
      const f = await fixture('own', 5);
      const made = (await call('post', '/me/bookings', { token: a.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(201)).body;
      await call('get', `/me/bookings/${made.id}`, { token: b.token }).expect(404);
      await call('post', `/me/bookings/${made.id}/cancel`, { token: b.token, body: {} }).expect(404);
      await call('post', `/me/bookings/${made.id}/submit`, { token: b.token }).expect(404);
      const theirs = (await call('post', '/me/travelers', { token: b.token, body: adultInput('Other') }).expect(201)).body.id;
      // Another customer's traveler cannot be put on my booking.
      await call('put', `/me/bookings/${made.id}/travelers`, { token: a.token, body: { leadTravelerId: theirs, assignments: [{ roomIndex: 0, travelerId: theirs }] } }).expect(422);
      expect((await call('get', '/me/bookings', { token: b.token }).expect(200)).body.items).toEqual([]);
    });

    it('limits unfinished drafts per customer', async () => {
      const c = await customer('drafts');
      const f = await fixture('drafts', 50);
      for (let i = 0; i < 5; i++) await call('post', '/me/bookings', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(201);
      expect((await call('post', '/me/bookings', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(409)).body.code).toBe('too_many_drafts');
    });
  });

  /* ------------------------------ inventory ------------------------------ */

  describe('seat inventory', () => {
    it('never oversells when customers book the last seats at the same time', async () => {
      const f = await fixture('race', 3);
      const people = await Promise.all([customer('race-1'), customer('race-2'), customer('race-3')]);
      const body = { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 2, children: 0, infants: 0 }] };
      const results = await Promise.all(people.map((p) => call('post', '/me/bookings', { token: p.token, body })));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'sold_out')).toBe(true);
      expect(await seats(f.departureId)).toBe(2);
    });

    it('releases seats when an unfinished draft times out, exactly once', async () => {
      const c = await customer('expiry');
      const f = await fixture('expiry', 5);
      const b = (await call('post', '/me/bookings', { token: c.token, body: { departureId: f.departureId, rooms: [{ occupancy: 'DOUBLE', adults: 2, children: 0, infants: 0 }] } }).expect(201)).body;
      expect(await seats(f.departureId)).toBe(2);
      await prisma.booking.update({ where: { id: b.id }, data: { seatHoldExpiresAt: new Date(Date.now() - 1000) } });

      const traveler = (await call('post', '/me/travelers', { token: c.token, body: adultInput('Late') }).expect(201)).body.id;
      const late = await call('put', `/me/bookings/${b.id}/travelers`, { token: c.token, body: { leadTravelerId: traveler, assignments: [{ roomIndex: 0, travelerId: traveler }] } }).expect(409);
      expect(late.body.code).toBe('hold_expired');
      expect(await seats(f.departureId)).toBe(0);

      const after = await call('get', `/me/bookings/${b.id}`, { token: c.token }).expect(200);
      expect(after.body).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Seat hold expired' });
      await call('get', '/me/bookings', { token: c.token }).expect(200);
      expect(await seats(f.departureId)).toBe(0);
    });
  });
});
