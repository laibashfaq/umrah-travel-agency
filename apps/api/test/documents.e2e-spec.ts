import fs from 'node:fs';
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

const PASSWORD = 'correct horse battery staple';
const runId = Date.now().toString(36);
const day = (offset: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + offset));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const STORAGE_ROOT = path.resolve(__dirname, '../../../.local/storage');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF fake image bytes'), Buffer.from([0xff, 0xd9])]);

type Method = 'get' | 'post' | 'put' | 'delete';

describe('Documents and visa applications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const packageIds: string[] = [];
  let ipCounter = 0;
  const freshIp = () => `10.80.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;

  const call = (method: Method, url: string, opts: { body?: object; token?: string } = {}) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`).set('x-internal-key', INTERNAL_KEY).set('x-client-ip', freshIp());
    if (opts.token) r = r.set('Authorization', `Bearer ${opts.token}`);
    return opts.body ? r.send(opts.body) : r;
  };

  /** Upload the file as the raw request body, the way the web app does. */
  const upload = (token: string, query: Record<string, string>, bytes: Buffer, base = '/me/documents') => {
    const qs = new URLSearchParams(query).toString();
    return request(app.getHttpServer())
      .post(`/api/v1${base}?${qs}`)
      .set('x-internal-key', INTERNAL_KEY)
      .set('x-client-ip', freshIp())
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);
  };

  async function customer(tag: string) {
    const email = `e2e-doc-${tag}-${runId}@example.com`;
    const user = await prisma.user.create({
      data: { email, passwordHash: await app.get(PasswordService).hash(PASSWORD), type: 'CUSTOMER', status: 'ACTIVE', firstName: 'Cust', lastName: tag, emailVerifiedAt: new Date() },
    });
    const c = await prisma.customer.create({ data: { userId: user.id, firstName: 'Cust', lastName: tag, email } });
    userIds.push(user.id);
    customerIds.push(c.id);
    const login = await call('post', '/auth/login', { body: { email, password: PASSWORD } }).expect(200);
    const traveler = (
      await call('post', '/me/travelers', {
        token: login.body.tokens.accessToken,
        body: { firstName: 'Ali', lastName: tag, gender: 'MALE', dateOfBirth: '1980-01-01', nationality: 'PK', passportNumber: `DC${runId.toUpperCase().slice(0, 5)}${tag.length}`.padEnd(7, '0'), passportExpiryDate: ymd(day(1200)) },
      }).expect(201)
    ).body;
    return { customerId: c.id, email, token: login.body.tokens.accessToken as string, travelerId: traveler.id as string };
  }

  async function staff(tag: string, role: RoleKey) {
    const email = `e2e-doc-staff-${tag}-${runId}@example.com`;
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

  /** A customer, their traveler and a confirmed booking carrying that traveler. */
  async function confirmedBooking(tag: string) {
    const c = await customer(tag);
    const pkg = await prisma.package.create({
      data: {
        slug: `e2e-doc-${tag}-${runId}`,
        title: `E2E Docs ${tag}`,
        durationDays: 14,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        departures: { create: { departureDate: day(60), returnDate: day(74), seatsTotal: 10, status: 'OPEN', prices: { create: [{ occupancy: 'DOUBLE', adultPrice: '300000.00' }] } } },
      },
      include: { departures: true },
    });
    packageIds.push(pkg.id);
    const b = (await call('post', '/me/bookings', { token: c.token, body: { departureId: pkg.departures[0]!.id, rooms: [{ occupancy: 'DOUBLE', adults: 1, children: 0, infants: 0 }] } }).expect(201)).body;
    await call('put', `/me/bookings/${b.id}/travelers`, { token: c.token, body: { leadTravelerId: c.travelerId, assignments: [{ roomIndex: 0, travelerId: c.travelerId }] } }).expect(200);
    await call('post', `/me/bookings/${b.id}/submit`, { token: c.token }).expect(200);
    return { ...c, bookingId: b.id as string, reference: b.reference as string };
  }
  const confirm = (bookingId: string) => prisma.booking.update({ where: { id: bookingId }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });

  const fileOnDisk = (key: string) => fs.existsSync(path.join(STORAGE_ROOT, key));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailerService).useValue({ sendTemplate: async () => 'NOT_DELIVERED', send: async () => 'NOT_DELIVERED' }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ENV));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const keys = (await prisma.document.findMany({ where: { customerId: { in: customerIds } }, select: { storageKey: true } })).map((d) => d.storageKey);
    for (const k of keys) fs.rmSync(path.join(STORAGE_ROOT, k), { force: true });
    await prisma.visaStatusHistory.deleteMany({ where: { visaApplication: { booking: { customerId: { in: customerIds } } } } });
    await prisma.document.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.visaApplication.deleteMany({ where: { booking: { customerId: { in: customerIds } } } });
    const owned = { booking: { customerId: { in: customerIds } } };
    await prisma.payment.deleteMany({ where: owned });
    await prisma.invoice.deleteMany({ where: owned });
    await prisma.booking.deleteMany({ where: { OR: [{ customerId: { in: customerIds } }, { packageId: { in: packageIds } }] } });
    await prisma.traveler.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.packageDeparture.deleteMany({ where: { packageId: { in: packageIds } } });
    await prisma.package.deleteMany({ where: { id: { in: packageIds } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { status: 'DEACTIVATED', deletedAt: new Date() } });
    await prisma.session.updateMany({ where: { userId: { in: userIds }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'test_cleanup' } });
    await app?.close();
  });

  /* ------------------------------ customer uploads ------------------------------ */

  describe('customer uploads', () => {
    it('stores a real PDF privately, waits for review, and returns exactly the same bytes', async () => {
      const c = await customer('up');
      const res = await upload(c.token, { type: 'PASSPORT', travelerId: c.travelerId, fileName: '../../My Passport.PDF' }, PDF).expect(201);
      expect(res.body).toMatchObject({ type: 'PASSPORT', status: 'PENDING_REVIEW', mimeType: 'application/pdf', sizeBytes: PDF.length, travelerId: c.travelerId, uploadedByStaff: false });
      expect(res.body.fileName).toBe('My Passport.pdf'); // path stripped, extension from the real content
      expect(JSON.stringify(res.body)).not.toMatch(/storageKey|documents\//);

      const row = await prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.storageKey).toMatch(/^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/); // unguessable, no file name in it
      expect(row.checksumSha256).toHaveLength(64);
      expect(row.scanStatus).toBe('PENDING'); // honest: no scanner is connected
      expect(fileOnDisk(row.storageKey)).toBe(true);

      const dl = await call('get', `/me/documents/${res.body.id}/file`, { token: c.token }).expect(200);
      expect(Buffer.from(dl.body).equals(PDF) || Buffer.from(dl.text, 'latin1').equals(PDF)).toBe(true);
      expect(dl.headers['content-type']).toContain('application/pdf');
      expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(dl.headers['cache-control']).toContain('no-store');
      expect(await prisma.auditLog.count({ where: { entityId: res.body.id, action: 'document.downloaded' } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityId: res.body.id, action: 'document.uploaded' } })).toBe(1);
    });

    it('refuses anything that is not really a PDF, JPEG or PNG, and bad requests', async () => {
      const c = await customer('bad');
      const q = { type: 'PASSPORT', travelerId: c.travelerId, fileName: 'x.pdf' };
      expect((await upload(c.token, q, Buffer.from('<html><script>alert(1)</script></html>')).expect(415)).body.code).toBe('unsupported_file');
      expect((await upload(c.token, { ...q, fileName: 'virus.pdf' }, Buffer.from('MZ\x90\x00 executable')).expect(415)).body.code).toBe('unsupported_file');
      expect((await upload(c.token, q, Buffer.alloc(0)).expect(400)).body.code).toBe('no_file');
      const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
      expect((await upload(c.token, q, big).expect(413)).body.code).toBe('too_large');
      expect((await upload(c.token, { type: 'PASSPORT', fileName: 'x.pdf' }, PDF).expect(400)).body.code).toBe('traveler_required');
      expect((await upload(c.token, { type: 'PAYMENT_PROOF', travelerId: c.travelerId, fileName: 'x.pdf' }, PDF).expect(400)).body.code).toBe('unsupported_type');
      await upload(c.token, { type: 'PASSPORT', travelerId: c.travelerId }, PDF).expect(400); // file name required
      await upload(c.token, { type: 'VISA', travelerId: c.travelerId, fileName: 'x.pdf' }, PDF).expect(400); // customers cannot upload a visa
      expect(await prisma.document.count({ where: { customerId: c.customerId } })).toBe(0);
    });

    it('keeps documents private to their owner', async () => {
      const a = await customer('own-a');
      const b = await customer('own-b');
      const doc = (await upload(a.token, { type: 'PHOTO', travelerId: a.travelerId, fileName: 'me.jpg' }, JPEG).expect(201)).body;
      await call('get', `/me/documents/${doc.id}/file`, { token: b.token }).expect(404);
      await call('delete', `/me/documents/${doc.id}`, { token: b.token }).expect(404);
      expect((await call('get', '/me/documents', { token: b.token }).expect(200)).body).toEqual([]);
      expect((await upload(b.token, { type: 'PASSPORT', travelerId: a.travelerId, fileName: 'x.pdf' }, PDF).expect(404)).body.code).toBe('not_found'); // someone else's traveler
      await call('get', `/me/documents/${doc.id}/file`).expect(401);
    });
  });

  /* ------------------------------ staff review ------------------------------ */

  describe('staff review and download', () => {
    it('reviews with a reason, locks approved files, and records every download', async () => {
      const c = await customer('rev');
      const officer = await staff('rev-visa', 'VISA_OFFICER');
      const finance = await staff('rev-fin', 'FINANCE_OFFICER');
      const sales = await staff('rev-sales', 'SALES_AGENT');
      const doc = (await upload(c.token, { type: 'PASSPORT', travelerId: c.travelerId, fileName: 'p.pdf' }, PDF).expect(201)).body;

      // Who may do what.
      await call('get', '/admin/documents', { token: c.token }).expect(403);
      await call('get', '/admin/documents', { token: sales.token }).expect(403);
      await call('post', `/admin/documents/${doc.id}/review`, { token: finance.token, body: { decision: 'APPROVE' } }).expect(403); // finance can read, not review
      await call('get', `/admin/documents/${doc.id}/file`, { token: finance.token }).expect(200);
      const queue = await call('get', '/admin/documents?status=PENDING_REVIEW', { token: officer.token }).expect(200);
      expect(queue.body.items.map((d: { id: string }) => d.id)).toContain(doc.id);

      // Rejecting needs a reason; the customer sees it and may remove the file.
      await call('post', `/admin/documents/${doc.id}/review`, { token: officer.token, body: { decision: 'REJECT' } }).expect(400);
      const rejected = await call('post', `/admin/documents/${doc.id}/review`, { token: officer.token, body: { decision: 'REJECT', reason: 'Photo page is cut off' } }).expect(200);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'Photo page is cut off', reviewedByName: 'Staff rev-visa' });
      expect((await call('post', `/admin/documents/${doc.id}/review`, { token: officer.token, body: { decision: 'APPROVE' } }).expect(409)).body.code).toBe('already_reviewed');
      expect((await call('get', '/me/documents', { token: c.token }).expect(200)).body[0]).toMatchObject({ status: 'REJECTED', rejectionReason: 'Photo page is cut off' });

      const key1 = (await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).storageKey;
      await call('delete', `/me/documents/${doc.id}`, { token: c.token }).expect(204);
      expect(fileOnDisk(key1)).toBe(false); // the personal file itself is erased
      expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).deletedAt).not.toBeNull(); // the record stays for audit
      await call('get', `/me/documents/${doc.id}/file`, { token: c.token }).expect(404);

      // Re-upload, approve, and the customer can no longer remove it.
      const again = (await upload(c.token, { type: 'PASSPORT', travelerId: c.travelerId, fileName: 'p2.pdf' }, PDF).expect(201)).body;
      const ok = await call('post', `/admin/documents/${again.id}/review`, { token: officer.token, body: { decision: 'APPROVE', expiresAt: ymd(day(1500)) } }).expect(200);
      expect(ok.body).toMatchObject({ status: 'APPROVED', expiresAt: ymd(day(1500)) });
      expect((await call('delete', `/me/documents/${again.id}`, { token: c.token }).expect(409)).body.code).toBe('approved_locked');

      await call('get', `/admin/documents/${again.id}/file`, { token: officer.token }).expect(200);
      const downloads = await prisma.auditLog.findMany({ where: { entityId: again.id, action: 'document.downloaded' } });
      expect(downloads).toHaveLength(1);
      expect(downloads[0]!.actorUserId).toBe(officer.id);
    });

    it('lets staff attach issued documents to a traveler, but only staff', async () => {
      const c = await customer('staffup');
      const officer = await staff('staffup-visa', 'VISA_OFFICER');
      const sales = await staff('staffup-sales', 'SALES_AGENT');
      const q = { type: 'VISA', travelerId: c.travelerId, fileName: 'visa.pdf' };
      await upload(sales.token, q, PDF, '/admin/documents').expect(403);
      const doc = (await upload(officer.token, q, PDF, '/admin/documents').expect(201)).body;
      expect(doc).toMatchObject({ type: 'VISA', status: 'APPROVED', uploadedByStaff: true });
      expect((await call('get', '/me/documents', { token: c.token }).expect(200)).body.map((d: { type: string }) => d.type)).toContain('VISA');
    });
  });

  /* ------------------------------ visa applications ------------------------------ */

  describe('visa applications', () => {
    it('walks a traveler from documents to an issued visa, enforcing each rule', async () => {
      const b = await confirmedBooking('visa');
      await prisma.booking.update({ where: { id: b.bookingId }, data: { status: 'PENDING_PAYMENT', confirmedAt: null } });
      const officer = await staff('visa-off', 'VISA_OFFICER');
      const manager = await staff('visa-mgr', 'BOOKING_MANAGER');

      // Not before the booking is confirmed.
      expect((await call('post', `/admin/bookings/${b.bookingId}/visas`, { token: officer.token }).expect(409)).body.code).toBe('booking_not_confirmed');
      await confirm(b.bookingId);
      await call('post', `/admin/bookings/${b.bookingId}/visas`, { token: manager.token }).expect(403); // may read, not start
      const started = (await call('post', `/admin/bookings/${b.bookingId}/visas`, { token: officer.token }).expect(201)).body;
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ status: 'DOCUMENTS_PENDING', bookingReference: b.reference, missingDocuments: ['Passport (photo page)', 'Passport-style photo'] });
      expect((await call('post', `/admin/bookings/${b.bookingId}/visas`, { token: officer.token }).expect(201)).body).toHaveLength(1); // no duplicates
      const id = started[0].id as string;
      const move = (body: object, token = officer.token) => call('post', `/admin/visas/${id}/status`, { token, body });

      // Rules on the way.
      expect((await move({ toStatus: 'SUBMITTED' }).expect(422)).body.code).toBe('invalid_transition');
      expect((await move({ toStatus: 'UNDER_REVIEW' }).expect(422)).body.code).toBe('documents_missing');

      const passport = (await upload(b.token, { type: 'PASSPORT', travelerId: b.travelerId, fileName: 'p.pdf' }, PDF).expect(201)).body;
      const photo = (await upload(b.token, { type: 'PHOTO', travelerId: b.travelerId, fileName: 'f.jpg' }, JPEG).expect(201)).body;
      expect((await move({ toStatus: 'UNDER_REVIEW', note: 'Checking' }).expect(200)).body.status).toBe('UNDER_REVIEW');
      expect((await move({ toStatus: 'READY_TO_SUBMIT' }).expect(422)).body.code).toBe('documents_not_approved');

      await call('post', `/admin/documents/${passport.id}/review`, { token: officer.token, body: { decision: 'APPROVE' } }).expect(200);
      expect((await move({ toStatus: 'READY_TO_SUBMIT' }).expect(422)).body.code).toBe('documents_not_approved'); // photo still waiting
      await call('post', `/admin/documents/${photo.id}/review`, { token: officer.token, body: { decision: 'APPROVE' } }).expect(200);
      const ready = (await move({ toStatus: 'READY_TO_SUBMIT' }).expect(200)).body;
      expect(ready).toMatchObject({ status: 'READY_TO_SUBMIT', missingDocuments: [] });

      const submitted = (await move({ toStatus: 'SUBMITTED', applicationNumber: 'APP-1001', externalReference: 'NUSUK-77' }).expect(200)).body;
      expect(submitted).toMatchObject({ status: 'SUBMITTED', applicationNumber: 'APP-1001', externalReference: 'NUSUK-77' });
      expect(submitted.submittedAt).not.toBeNull();
      await move({ toStatus: 'IN_PROCESS' }).expect(200);
      await move({ toStatus: 'APPROVED' }).expect(200);

      // Issuing needs the visa details.
      await move({ toStatus: 'ISSUED' }).expect(400);
      await move({ toStatus: 'ISSUED', visaNumber: 'V-998877', validFrom: ymd(day(55)), validUntil: ymd(day(54)) }).expect(400);

      // Until it is issued the customer sees progress but none of the internal details.
      const midway = (await call('get', '/me/visas', { token: b.token }).expect(200)).body[0];
      expect(midway).toMatchObject({ status: 'APPROVED', visaNumber: null, applicationNumber: null, externalReference: null, assignedOfficerName: null, allowedTransitions: [] });
      expect(midway.message).toMatch(/approved/i);
      expect(midway.history.every((h: { note: string | null }) => h.note === null)).toBe(true);

      const issued = (await move({ toStatus: 'ISSUED', visaNumber: 'V-998877', validFrom: ymd(day(55)), validUntil: ymd(day(85)) }).expect(200)).body;
      expect(issued).toMatchObject({ status: 'ISSUED', visaNumber: 'V-998877', allowedTransitions: [] });
      expect(issued.issuedAt).not.toBeNull();
      const mine = (await call('get', '/me/visas', { token: b.token }).expect(200)).body[0];
      expect(mine).toMatchObject({ status: 'ISSUED', visaNumber: 'V-998877', validUntil: ymd(day(85)) });
      expect(mine.externalReference).toBeNull();
      await move({ toStatus: 'CANCELLED' }).expect(422); // finished applications stay finished

      const actions = (await prisma.auditLog.findMany({ where: { entityId: id, action: 'visa.status_changed' } })).length;
      expect(actions).toBe(6);
    });

    it('handles a rejection: a reason is required and the customer can resubmit', async () => {
      const b = await confirmedBooking('visa-rej');
      await confirm(b.bookingId);
      const officer = await staff('rej-off', 'VISA_OFFICER');
      const id = (await call('post', `/admin/bookings/${b.bookingId}/visas`, { token: officer.token }).expect(201)).body[0].id as string;
      await upload(b.token, { type: 'PASSPORT', travelerId: b.travelerId, fileName: 'p.pdf' }, PDF).expect(201);
      await upload(b.token, { type: 'PHOTO', travelerId: b.travelerId, fileName: 'f.jpg' }, JPEG).expect(201);
      const move = (body: object) => call('post', `/admin/visas/${id}/status`, { token: officer.token, body });
      await move({ toStatus: 'UNDER_REVIEW' }).expect(200);
      await move({ toStatus: 'REJECTED' }).expect(400);
      const rejected = (await move({ toStatus: 'REJECTED', rejectionReason: 'Passport expires too soon' }).expect(200)).body;
      expect(rejected).toMatchObject({ status: 'REJECTED', rejectionReason: 'Passport expires too soon', allowedTransitions: ['DOCUMENTS_PENDING'] });
      expect((await call('get', '/me/visas', { token: b.token }).expect(200)).body[0]).toMatchObject({ status: 'REJECTED', rejectionReason: 'Passport expires too soon' });
      const back = (await move({ toStatus: 'DOCUMENTS_PENDING' }).expect(200)).body;
      expect(back).toMatchObject({ status: 'DOCUMENTS_PENDING', rejectionReason: null });
    });

    it('assigns officers who can work on visas, lists and filters, and keeps customers out', async () => {
      const b = await confirmedBooking('visa-asg');
      await confirm(b.bookingId);
      const officer = await staff('asg-off', 'VISA_OFFICER');
      const finance = await staff('asg-fin', 'FINANCE_OFFICER');
      const id = (await call('post', `/admin/bookings/${b.bookingId}/visas`, { token: officer.token }).expect(201)).body[0].id as string;
      expect((await call('post', `/admin/visas/${id}/assign`, { token: officer.token, body: { assignedOfficerId: finance.id } }).expect(422)).body.code).toBe('invalid_assignee');
      expect((await call('post', `/admin/visas/${id}/assign`, { token: officer.token, body: { assignedOfficerId: officer.id } }).expect(200)).body.assignedOfficerName).toBe('Staff asg-off');
      const mine = await call('get', `/admin/visas?assignedOfficerId=${officer.id}&status=DOCUMENTS_PENDING`, { token: officer.token }).expect(200);
      expect(mine.body.items.map((v: { id: string }) => v.id)).toContain(id);
      expect((await call('get', '/admin/visas/officers', { token: officer.token }).expect(200)).body.map((o: { id: string }) => o.id)).toContain(officer.id);
      await call('get', '/admin/visas', { token: finance.token }).expect(403);
      await call('get', '/admin/visas', { token: b.token }).expect(403);
      const other = await customer('visa-other');
      expect((await call('get', '/me/visas', { token: other.token }).expect(200)).body).toEqual([]);
    });
  });
});
