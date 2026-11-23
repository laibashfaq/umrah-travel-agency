import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
const INTERNAL_KEY = 'e2e-internal-key-0123456789abcdef';
process.env.INTERNAL_API_KEY = INTERNAL_KEY;
process.env.EMAIL_PROVIDER = 'log';

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { ROLE_KEYS, type RoleKey } from '@umrah/shared';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { TokenService } from '../src/auth/token.service';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { generateTotpSecret, totpAt } from '../src/auth/totp';
import { configureApp } from '../src/bootstrap';
import { FieldEncryption } from '../src/common/crypto/field-encryption';
import { ENV } from '../src/config/config.module';
import { MailerService } from '../src/mail/mailer.service';
import { PrismaService } from '../src/prisma/prisma.service';

/** Captures outgoing email instead of sending it, so flows that need a link can be completed. */
class CapturingMailer {
  sent: { template: string; to: string; vars: Record<string, string> }[] = [];
  async sendTemplate(template: string, to: string, vars: Record<string, string>) {
    this.sent.push({ template, to, vars });
    return 'NOT_DELIVERED' as const;
  }
  async send() {
    return 'NOT_DELIVERED' as const;
  }
  last(template: string, to: string) {
    return [...this.sent].reverse().find((m) => m.template === template && m.to === to);
  }
  tokenFor(template: string, to: string): string {
    const msg = this.last(template, to);
    if (!msg) throw new Error(`No ${template} email for ${to}`);
    return new URL(msg.vars.link!).searchParams.get('token')!;
  }
}

const STRONG = 'correct horse battery staple';
const NEW_STRONG = 'another very long passphrase 42';
const runId = Date.now().toString(36);
const emailOf = (tag: string) => `e2e-auth-${tag}-${runId}@example.com`;

describe('Authentication, sessions, 2FA and RBAC (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwords: PasswordService;
  let enc: FieldEncryption;
  let tokens: TokenService;
  let twoFactor: TwoFactorService;
  let accessSecret: string;
  const mailer = new CapturingMailer();
  const createdUserIds: string[] = [];
  const createdEmails: string[] = [];
  let ipCounter = 0;
  const freshIp = () => {
    ipCounter++;
    return `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.${Math.floor(Math.random() * 200) + 1}`;
  };

  /** Every call gets its own client IP (the API trusts x-client-ip only together with the internal key). */
  const call = (method: 'get' | 'post' | 'delete', url: string, opts: { body?: object; token?: string; ip?: string } = {}) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`).set('x-internal-key', INTERNAL_KEY).set('x-client-ip', opts.ip ?? freshIp());
    if (opts.token) r = r.set('Authorization', `Bearer ${opts.token}`);
    return opts.body ? r.send(opts.body) : r;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailerService).useValue(mailer).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ENV));
    await app.init();
    prisma = app.get(PrismaService);
    passwords = app.get(PasswordService);
    enc = app.get(FieldEncryption);
    tokens = app.get(TokenService);
    twoFactor = app.get(TwoFactorService);
    accessSecret = app.get(ENV).JWT_ACCESS_SECRET;
  });

  afterAll(async () => {
    // Audit rows are append-only and reference users, so test accounts are deactivated rather than deleted.
    await prisma.user.updateMany({ where: { id: { in: createdUserIds } }, data: { status: 'DEACTIVATED', deletedAt: new Date() } });
    await prisma.session.updateMany({ where: { userId: { in: createdUserIds }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'test_cleanup' } });
    await app?.close();
  });

  /* ------------------------------ helpers ------------------------------ */

  async function makeCustomer(tag: string, status: 'ACTIVE' | 'PENDING_VERIFICATION' = 'ACTIVE') {
    const email = emailOf(tag);
    createdEmails.push(email);
    const user = await prisma.user.create({
      data: { email, passwordHash: await passwords.hash(STRONG), type: 'CUSTOMER', status, firstName: 'Test', lastName: 'Customer', emailVerifiedAt: status === 'ACTIVE' ? new Date() : null },
    });
    createdUserIds.push(user.id);
    return { id: user.id, email, password: STRONG };
  }

  async function makeStaff(tag: string, role: RoleKey, opts: { twoFactor?: boolean } = {}) {
    const email = emailOf(tag);
    const secret = generateTotpSecret();
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role } });
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await passwords.hash(STRONG),
        type: 'STAFF',
        status: 'ACTIVE',
        firstName: 'Staff',
        lastName: role,
        emailVerifiedAt: new Date(),
        twoFactorEnabled: opts.twoFactor ?? true,
        twoFactorSecretEnc: opts.twoFactor === false ? null : enc.encrypt(secret),
        roles: { create: { roleId: roleRow.id } },
      },
    });
    createdUserIds.push(user.id);
    return { id: user.id, email, password: STRONG, secret };
  }

  /** Code for a time-step offset (-1, 0, +1 are all accepted); use increasing offsets to log in repeatedly within 30s. */
  const code = (secret: string, stepOffset = 0) => totpAt(secret, Date.now() + stepOffset * 30_000);

  async function login(u: { email: string; password: string }) {
    const res = await call('post', '/auth/login', { body: { email: u.email, password: u.password } }).expect(200);
    expect(res.body.status).toBe('authenticated');
    return res.body as { tokens: { accessToken: string; refreshToken: string }; user: { id: string; permissions: string[]; roles: { key: string }[] } };
  }

  async function staffLogin(u: { email: string; password: string; secret: string }, stepOffset = 0) {
    const first = await call('post', '/auth/login', { body: { email: u.email, password: u.password } }).expect(200);
    expect(first.body.status).toBe('two_factor_required');
    const second = await call('post', '/auth/2fa/verify', { body: { challengeToken: first.body.challengeToken, code: code(u.secret, stepOffset) } }).expect(200);
    expect(second.body.status).toBe('authenticated');
    return second.body as { tokens: { accessToken: string; refreshToken: string }; user: { id: string; permissions: string[]; roles: { key: string }[] } };
  }

  /* ============================== registration ============================== */

  describe('registration and email verification', () => {
    const email = emailOf('reg');
    createdEmails.push(email);

    it('rejects weak passwords with field errors and does not create a user', async () => {
      const res = await call('post', '/auth/register', { body: { firstName: 'Ali', lastName: 'Khan', email, password: 'password1234', acceptTerms: true } }).expect(400);
      expect(res.body.errors.some((e: { field: string }) => e.field === 'password')).toBe(true);
      expect(await prisma.user.count({ where: { email } })).toBe(0);
      await call('post', '/auth/register', { body: { firstName: 'Ali', lastName: 'Khan', email, password: STRONG, acceptTerms: false } }).expect(400);
      await call('post', '/auth/register', { body: { firstName: 'Ali', lastName: 'Khan', email: 'ali.khan.is.my.name@example.com', password: 'ali.khan.is.my.name', acceptTerms: true } }).expect(400);
    });

    it('registers, emails a verification link, and answers identically for a duplicate email (no enumeration)', async () => {
      const first = await call('post', '/auth/register', { body: { firstName: 'Ali', lastName: 'Khan', email: email.toUpperCase(), password: STRONG, acceptTerms: true } }).expect(202);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      createdUserIds.push(user.id);
      expect(user).toMatchObject({ type: 'CUSTOMER', status: 'PENDING_VERIFICATION', emailVerifiedAt: null });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(mailer.last('auth.verify_email', email)).toBeDefined();

      const dupe = await call('post', '/auth/register', { body: { firstName: 'Someone', lastName: 'Else', email, password: STRONG, acceptTerms: true } }).expect(202);
      expect(dupe.body).toEqual(first.body);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(mailer.last('auth.already_registered', email)).toBeDefined();
    });

    it('lets an unverified customer sign in but not yet have a customer record', async () => {
      const { tokens: t } = await login({ email, password: STRONG });
      const me = await call('get', '/auth/me', { token: t.accessToken }).expect(200);
      expect(me.body).toMatchObject({ email, type: 'CUSTOMER', status: 'PENDING_VERIFICATION', emailVerified: false, customerId: null, permissions: [] });
    });

    it('verifies once, activates the account and creates the customer record; the link then stops working', async () => {
      const token = mailer.tokenFor('auth.verify_email', email);
      await call('post', '/auth/verify-email', { body: { token } }).expect(200);
      const { tokens: t } = await login({ email, password: STRONG });
      const me = await call('get', '/auth/me', { token: t.accessToken }).expect(200);
      expect(me.body).toMatchObject({ status: 'ACTIVE', emailVerified: true });
      expect(me.body.customerId).toBeTruthy();
      await call('post', '/auth/verify-email', { body: { token } }).expect(400);
      await call('post', '/auth/verify-email', { body: { token: 'x'.repeat(43) } }).expect(400);
    });

    it('links an existing staff-created customer only after the email is verified', async () => {
      const mail = emailOf('link');
      const existing = await prisma.customer.create({ data: { firstName: 'Pre', lastName: 'Existing', email: mail, phone: '+923001234567' } });
      await call('post', '/auth/register', { body: { firstName: 'Pre', lastName: 'Existing', email: mail, password: STRONG, acceptTerms: true } }).expect(202);
      const user = await prisma.user.findUniqueOrThrow({ where: { email: mail } });
      createdUserIds.push(user.id);
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: existing.id } })).userId).toBeNull();
      await call('post', '/auth/verify-email', { body: { token: mailer.tokenFor('auth.verify_email', mail) } }).expect(200);
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: existing.id } })).userId).toBe(user.id);
      expect(await prisma.customer.count({ where: { userId: user.id } })).toBe(1);
    });

    it('resend-verification answers the same for unknown and pending accounts', async () => {
      const unknown = await call('post', '/auth/resend-verification', { body: { email: emailOf('nobody') } }).expect(202);
      const pending = await makeCustomer('pending', 'PENDING_VERIFICATION');
      const known = await call('post', '/auth/resend-verification', { body: { email: pending.email } }).expect(202);
      expect(known.body).toEqual(unknown.body);
      expect(mailer.last('auth.verify_email', pending.email)).toBeDefined();
    });
  });

  /* ================================ sign in ================================ */

  describe('sign in', () => {
    it('gives the same error for a wrong password and an unknown account', async () => {
      const u = await makeCustomer('same');
      const wrong = await call('post', '/auth/login', { body: { email: u.email, password: 'wrong password here' } }).expect(401);
      const unknown = await call('post', '/auth/login', { body: { email: emailOf('ghost'), password: 'wrong password here' } }).expect(401);
      expect(wrong.body.message).toBe(unknown.body.message);
      expect(wrong.body.code).toBe('invalid_credentials');
    });

    it('locks the account after repeated failures and records it without leaking the password', async () => {
      const u = await makeCustomer('lock');
      for (let i = 0; i < 5; i++) await call('post', '/auth/login', { body: { email: u.email, password: 'definitely wrong 1' } }).expect(401);
      const locked = await call('post', '/auth/login', { body: { email: u.email, password: u.password } }).expect(429);
      expect(locked.body.code).toBe('account_locked');
      const audit = await prisma.auditLog.findMany({ where: { actorUserId: u.id, action: { in: ['auth.login_failed', 'auth.account_locked'] } } });
      expect(audit.some((a) => a.action === 'auth.account_locked')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain('definitely wrong');
      // Unlocks once the lock expires.
      await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      await login(u);
    });

    it('refuses suspended accounts even with the right password', async () => {
      const u = await makeCustomer('susp');
      await prisma.user.update({ where: { id: u.id }, data: { status: 'SUSPENDED' } });
      const res = await call('post', '/auth/login', { body: { email: u.email, password: u.password } }).expect(403);
      expect(res.body.code).toBe('account_inactive');
    });

    it('rate limits sign-in attempts per client IP, and ignores a spoofed x-client-ip without the internal key', async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await call('post', '/auth/login', { ip, body: { email: emailOf(`rl${i}`), password: 'nope nope nope nope' } })).status);
      expect(statuses).toContain(429);
      // Without the internal key, rotating x-client-ip must not reset the limit (all requests share the socket IP).
      const raw: number[] = [];
      for (let i = 0; i < 12; i++) {
        raw.push((await request(app.getHttpServer()).post('/api/v1/auth/login').set('x-client-ip', `10.9.9.${i + 1}`).send({ email: emailOf(`sp${i}`), password: 'nope nope nope nope' })).status);
      }
      expect(raw).toContain(429);
    });

    it('validates the request body', async () => {
      await call('post', '/auth/login', { body: { email: 'not-an-email', password: 'x' } }).expect(400);
      await call('post', '/auth/login', { body: {} }).expect(400);
    });
  });

  /* ============================ tokens and the guard ============================ */

  describe('bearer tokens and default-deny', () => {
    it('protects private routes and leaves public ones open', async () => {
      await call('get', '/auth/me').expect(401);
      await call('get', '/admin/roles').expect(401);
      await call('get', '/health').expect(200);
      await call('get', '/public/packages').expect(200);
    });

    it('rejects forged, expired, wrong-audience and flow tokens', async () => {
      const u = await makeCustomer('tok');
      const { tokens: t, user } = await login(u);
      await call('get', '/auth/me', { token: 'garbage' }).expect(401);
      await call('get', '/auth/me', { token: t.accessToken + 'x' }).expect(401);
      const claims = { sub: user.id, typ: 'CUSTOMER', fid: randomUUID() };
      const opts = { issuer: 'umrah-api', audience: 'umrah-web' } as const;
      await call('get', '/auth/me', { token: jwt.sign(claims, 'not-the-secret', { algorithm: 'HS256', ...opts }) }).expect(401);
      await call('get', '/auth/me', { token: jwt.sign(claims, accessSecret, { algorithm: 'HS256', expiresIn: -10, ...opts }) }).expect(401);
      await call('get', '/auth/me', { token: jwt.sign(claims, accessSecret, { algorithm: 'HS256', issuer: 'umrah-api', audience: 'someone-else' }) }).expect(401);
      // Valid signature but a login family that does not exist.
      await call('get', '/auth/me', { token: jwt.sign(claims, accessSecret, { algorithm: 'HS256', ...opts }) }).expect(401);
      // `alg: none` must never be accepted.
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...claims, iss: 'umrah-api', aud: 'umrah-web' })).toString('base64url')}.`;
      await call('get', '/auth/me', { token: none }).expect(401);
      // A multi-step login token is not a session.
      await call('get', '/auth/me', { token: tokens.signFlow(user.id, '2fa-challenge') }).expect(401);
      await call('get', '/auth/me', { token: t.accessToken }).expect(200);
    });

    it('re-reads the account on every request: suspension and deactivation apply immediately', async () => {
      const u = await makeCustomer('live');
      const { tokens: t } = await login(u);
      await call('get', '/auth/me', { token: t.accessToken }).expect(200);
      await prisma.user.update({ where: { id: u.id }, data: { status: 'SUSPENDED' } });
      await call('get', '/auth/me', { token: t.accessToken }).expect(401);
      const refresh = await call('post', '/auth/refresh', { body: { refreshToken: t.refreshToken } });
      expect(refresh.status).toBe(401);
    });

    it('returns a request id on every response, including errors, and never leaks internals', async () => {
      const res = await call('get', '/auth/me').expect(401);
      expect(res.headers['x-request-id']).toMatch(/^[\w-]{8,64}$/);
      expect(res.body).toMatchObject({ statusCode: 401, requestId: res.headers['x-request-id'] });
      expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|node_modules/);
    });
  });

  /* ============================ refresh and sessions ============================ */

  describe('refresh-token rotation', () => {
    it('rotates on every use and keeps the same login family', async () => {
      const u = await makeCustomer('rot');
      const { tokens: t1 } = await login(u);
      const r = await call('post', '/auth/refresh', { body: { refreshToken: t1.refreshToken } }).expect(200);
      expect(r.body.tokens.refreshToken).not.toBe(t1.refreshToken);
      expect(r.body.user.email).toBe(u.email);
      expect(tokens.verifyAccess(r.body.tokens.accessToken).fid).toBe(tokens.verifyAccess(t1.accessToken).fid);
      await call('get', '/auth/me', { token: r.body.tokens.accessToken }).expect(200);
      // Only a keyed hash of the token is stored.
      expect(await prisma.session.count({ where: { refreshTokenHash: t1.refreshToken } })).toBe(0);
    });

    it('treats a second use within the grace window as a harmless race, not an attack', async () => {
      const u = await makeCustomer('race');
      const { tokens: t1 } = await login(u);
      const r = await call('post', '/auth/refresh', { body: { refreshToken: t1.refreshToken } }).expect(200);
      const again = await call('post', '/auth/refresh', { body: { refreshToken: t1.refreshToken } }).expect(401);
      expect(again.body.code).toBe('refresh_race');
      await call('get', '/auth/me', { token: r.body.tokens.accessToken }).expect(200); // login survives
    });

    it('only one of two concurrent refreshes with the same token succeeds', async () => {
      const u = await makeCustomer('conc');
      const { tokens: t1 } = await login(u);
      const results = await Promise.all([1, 2].map(() => call('post', '/auth/refresh', { body: { refreshToken: t1.refreshToken } })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('detects token theft: replaying a rotated token later revokes the whole login and is audited', async () => {
      const u = await makeCustomer('theft');
      const { tokens: t1 } = await login(u);
      const r = await call('post', '/auth/refresh', { body: { refreshToken: t1.refreshToken } }).expect(200);
      // Age the rotation past the grace window.
      await prisma.session.updateMany({ where: { userId: u.id, revokedReason: 'rotated' }, data: { revokedAt: new Date(Date.now() - 60_000) } });
      const replay = await call('post', '/auth/refresh', { body: { refreshToken: t1.refreshToken } }).expect(401);
      expect(replay.body.code).toBe('session_invalid');
      // The legitimate holder of the newest token is signed out too.
      await call('post', '/auth/refresh', { body: { refreshToken: r.body.tokens.refreshToken } }).expect(401);
      await call('get', '/auth/me', { token: r.body.tokens.accessToken }).expect(401);
      expect(await prisma.auditLog.count({ where: { actorUserId: u.id, action: 'auth.refresh_token_reuse' } })).toBe(1);
    });

    it('rejects unknown and expired refresh tokens', async () => {
      await call('post', '/auth/refresh', { body: { refreshToken: 'x'.repeat(43) } }).expect(401);
      const u = await makeCustomer('exp');
      const { tokens: t } = await login(u);
      await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await call('post', '/auth/refresh', { body: { refreshToken: t.refreshToken } }).expect(401);
    });
  });

  describe('sessions and sign-out', () => {
    it('logout ends only this device; logout-all ends every device', async () => {
      const u = await makeCustomer('out');
      const a = await login(u);
      const b = await login(u);
      await call('post', '/auth/logout', { token: a.tokens.accessToken }).expect(204);
      await call('get', '/auth/me', { token: a.tokens.accessToken }).expect(401);
      await call('post', '/auth/refresh', { body: { refreshToken: a.tokens.refreshToken } }).expect(401);
      await call('get', '/auth/me', { token: b.tokens.accessToken }).expect(200);
      const c = await login(u);
      await call('post', '/auth/logout-all', { token: b.tokens.accessToken }).expect(204);
      await call('get', '/auth/me', { token: b.tokens.accessToken }).expect(401);
      await call('get', '/auth/me', { token: c.tokens.accessToken }).expect(401);
    });

    it('lists devices and lets a user revoke another one (but not someone else\'s)', async () => {
      const u = await makeCustomer('dev');
      const other = await makeCustomer('dev2');
      const a = await login(u);
      const b = await login(u);
      const o = await login(other);
      const list = await call('get', '/auth/sessions', { token: a.tokens.accessToken }).expect(200);
      expect(list.body).toHaveLength(2);
      expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      const bFamily = tokens.verifyAccess(b.tokens.accessToken).fid;
      const oFamily = tokens.verifyAccess(o.tokens.accessToken).fid;
      await call('delete', `/auth/sessions/${oFamily}`, { token: a.tokens.accessToken }).expect(400);
      await call('get', '/auth/me', { token: o.tokens.accessToken }).expect(200);
      await call('delete', `/auth/sessions/${bFamily}`, { token: a.tokens.accessToken }).expect(204);
      await call('get', '/auth/me', { token: b.tokens.accessToken }).expect(401);
      await call('delete', '/auth/sessions/not-a-uuid', { token: a.tokens.accessToken }).expect(400);
    });
  });

  /* ================================ passwords ================================ */

  describe('password reset and change', () => {
    it('answers forgot-password identically for known and unknown emails and sends one working link', async () => {
      const u = await makeCustomer('forgot');
      const known = await call('post', '/auth/forgot-password', { body: { email: u.email } }).expect(202);
      const unknown = await call('post', '/auth/forgot-password', { body: { email: emailOf('who') } }).expect(202);
      expect(known.body).toEqual(unknown.body);
      expect(mailer.last('auth.password_reset', u.email)).toBeDefined();
      expect(mailer.last('auth.password_reset', emailOf('who'))).toBeUndefined();
    });

    it('a weak password does not burn the link; a strong one resets, signs out every device and consumes the link', async () => {
      const u = await makeCustomer('reset');
      const old = await login(u);
      await call('post', '/auth/forgot-password', { body: { email: u.email } }).expect(202);
      const token = mailer.tokenFor('auth.password_reset', u.email);
      await call('post', '/auth/reset-password', { body: { token, password: 'password1234' } }).expect(400);
      await call('post', '/auth/reset-password', { body: { token, password: NEW_STRONG } }).expect(200);
      await call('post', '/auth/reset-password', { body: { token, password: NEW_STRONG + '!' } }).expect(400); // single use
      await call('get', '/auth/me', { token: old.tokens.accessToken }).expect(401);
      await call('post', '/auth/refresh', { body: { refreshToken: old.tokens.refreshToken } }).expect(401);
      await call('post', '/auth/login', { body: { email: u.email, password: u.password } }).expect(401);
      await login({ email: u.email, password: NEW_STRONG });
      expect(mailer.last('auth.password_changed', u.email)).toBeDefined();
    });

    it('only the newest reset link works, and a link of another purpose is refused', async () => {
      const u = await makeCustomer('newest');
      await call('post', '/auth/forgot-password', { body: { email: u.email } }).expect(202);
      const first = mailer.tokenFor('auth.password_reset', u.email);
      await call('post', '/auth/forgot-password', { body: { email: u.email } }).expect(202);
      const second = mailer.tokenFor('auth.password_reset', u.email);
      expect(second).not.toBe(first);
      await call('post', '/auth/reset-password', { body: { token: first, password: NEW_STRONG } }).expect(400);
      const verify = mailer.last('auth.verify_email', u.email)?.vars.link;
      expect(verify).toBeUndefined();
      await call('post', '/auth/reset-password', { body: { token: second, password: NEW_STRONG } }).expect(200);
    });

    it('expired reset links are refused', async () => {
      const u = await makeCustomer('stale');
      await call('post', '/auth/forgot-password', { body: { email: u.email } }).expect(202);
      const token = mailer.tokenFor('auth.password_reset', u.email);
      await prisma.userToken.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await call('post', '/auth/reset-password', { body: { token, password: NEW_STRONG } }).expect(400);
    });

    it('change-password needs the current password, enforces the policy, and keeps only this device signed in', async () => {
      const u = await makeCustomer('chg');
      const a = await login(u);
      const b = await login(u);
      await call('post', '/auth/change-password', { token: a.tokens.accessToken, body: { currentPassword: 'not my password', newPassword: NEW_STRONG } }).expect(401);
      await call('post', '/auth/change-password', { token: a.tokens.accessToken, body: { currentPassword: u.password, newPassword: 'password1234' } }).expect(400);
      await call('post', '/auth/change-password', { token: a.tokens.accessToken, body: { currentPassword: u.password, newPassword: u.password } }).expect(400);
      await call('post', '/auth/change-password', { token: a.tokens.accessToken, body: { currentPassword: u.password, newPassword: NEW_STRONG } }).expect(200);
      await call('get', '/auth/me', { token: a.tokens.accessToken }).expect(200);
      await call('get', '/auth/me', { token: b.tokens.accessToken }).expect(401);
      await login({ email: u.email, password: NEW_STRONG });
    });
  });

  /* ============================== staff two-factor ============================== */

  describe('staff two-factor authentication', () => {
    it('forces enrolment before any session exists, then stores the secret encrypted and issues backup codes once', async () => {
      const staff = await makeStaff('enrol', 'BOOKING_MANAGER', { twoFactor: false });
      const first = await call('post', '/auth/login', { body: { email: staff.email, password: staff.password } }).expect(200);
      expect(first.body.status).toBe('two_factor_setup_required');
      expect(first.body.tokens).toBeUndefined();
      expect(first.body.accessToken).toBeUndefined();
      expect(await prisma.session.count({ where: { userId: staff.id } })).toBe(0);

      // The setup token is not a session token...
      await call('get', '/auth/me', { token: first.body.setupToken }).expect(401);
      // ...and a challenge token cannot start setup.
      await call('post', '/auth/2fa/setup/start', { body: { setupToken: tokens.signFlow(staff.id, '2fa-challenge') } }).expect(401);

      const start = await call('post', '/auth/2fa/setup/start', { body: { setupToken: first.body.setupToken } }).expect(200);
      expect(start.body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(start.body.otpauthUri).toContain(`secret=${start.body.secret}`);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
      expect(row.twoFactorEnabled).toBe(false);
      expect(row.twoFactorSecretEnc).toMatch(/^v1:/);
      expect(row.twoFactorSecretEnc).not.toContain(start.body.secret);

      await call('post', '/auth/2fa/setup/confirm', { body: { setupToken: first.body.setupToken, code: '000000' } }).expect(400);
      const done = await call('post', '/auth/2fa/setup/confirm', { body: { setupToken: first.body.setupToken, code: totpAt(start.body.secret, Date.now()) } }).expect(200);
      expect(done.body.backupCodes).toHaveLength(10);
      expect(done.body.backupCodes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      expect(done.body.user).toMatchObject({ type: 'STAFF', twoFactorEnabled: true });
      expect(done.body.user.roles).toEqual([{ key: 'BOOKING_MANAGER', name: 'Booking Manager' }]);
      expect(done.body.user.permissions).toContain('bookings:read');
      await call('get', '/auth/me', { token: done.body.tokens.accessToken }).expect(200);
      // Backup codes are stored hashed.
      const stored = await prisma.twoFactorBackupCode.findMany({ where: { userId: staff.id } });
      expect(stored).toHaveLength(10);
      expect(stored.some((s) => done.body.backupCodes.some((c: string) => s.codeHash.includes(c.replace('-', ''))))).toBe(false);
      // Setup cannot be repeated once enabled.
      await call('post', '/auth/2fa/setup/start', { body: { setupToken: first.body.setupToken } }).expect(400);
    });

    it('requires a valid code on every sign-in and never accepts the same code twice (replay protection)', async () => {
      const staff = await makeStaff('code', 'FINANCE_OFFICER');
      const challenge = await call('post', '/auth/login', { body: { email: staff.email, password: staff.password } }).expect(200);
      expect(challenge.body).toMatchObject({ status: 'two_factor_required' });
      expect(challenge.body.tokens).toBeUndefined();
      await call('post', '/auth/2fa/verify', { body: { challengeToken: challenge.body.challengeToken, code: '123456' } }).expect(401);
      await call('post', '/auth/2fa/verify', { body: { challengeToken: 'x'.repeat(40), code: code(staff.secret) } }).expect(401);
      const ok = await call('post', '/auth/2fa/verify', { body: { challengeToken: challenge.body.challengeToken, code: code(staff.secret, -1) } }).expect(200);
      expect(ok.body.status).toBe('authenticated');

      // The same code (and any older step) is now burnt.
      const again = await call('post', '/auth/login', { body: { email: staff.email, password: staff.password } }).expect(200);
      await call('post', '/auth/2fa/verify', { body: { challengeToken: again.body.challengeToken, code: code(staff.secret, -1) } }).expect(401);
      await call('post', '/auth/2fa/verify', { body: { challengeToken: again.body.challengeToken, code: code(staff.secret, 0) } }).expect(200);
    });

    it('accepts each backup code exactly once and audits it', async () => {
      const staff = await makeStaff('backup', 'VISA_OFFICER');
      const generated = await twoFactor.regenerateBackupCodes(staff.id);
      const c1 = await call('post', '/auth/login', { body: { email: staff.email, password: staff.password } }).expect(200);
      await call('post', '/auth/2fa/verify', { body: { challengeToken: c1.body.challengeToken, backupCode: generated[0]!.toLowerCase() } }).expect(200);
      const c2 = await call('post', '/auth/login', { body: { email: staff.email, password: staff.password } }).expect(200);
      await call('post', '/auth/2fa/verify', { body: { challengeToken: c2.body.challengeToken, backupCode: generated[0] } }).expect(401);
      await call('post', '/auth/2fa/verify', { body: { challengeToken: c2.body.challengeToken, backupCode: generated[1] } }).expect(200);
      expect(await prisma.auditLog.count({ where: { actorUserId: staff.id, action: 'auth.backup_code_used' } })).toBe(2);
      await call('post', '/auth/2fa/verify', { body: { challengeToken: c2.body.challengeToken } }).expect(400); // need a code
      await call('post', '/auth/2fa/verify', { body: { challengeToken: c2.body.challengeToken, code: '123456', backupCode: generated[2] } }).expect(400); // not both
    });

    it('locks the account after repeated wrong codes', async () => {
      const staff = await makeStaff('brute', 'SALES_AGENT');
      const challenge = await call('post', '/auth/login', { body: { email: staff.email, password: staff.password } }).expect(200);
      for (let i = 0; i < 5; i++) await call('post', '/auth/2fa/verify', { body: { challengeToken: challenge.body.challengeToken, code: '000000' } }).expect(401);
      const locked = await call('post', '/auth/2fa/verify', { body: { challengeToken: challenge.body.challengeToken, code: code(staff.secret) } }).expect(429);
      expect(locked.body.code).toBe('account_locked');
    });

    it('does not let staff switch 2FA off while the policy requires it', async () => {
      const staff = await makeStaff('nodisable', 'CONTENT_MANAGER');
      const s = await staffLogin(staff, -1);
      const res = await call('post', '/auth/2fa/disable', { token: s.tokens.accessToken, body: { password: staff.password, code: code(staff.secret, 1) } }).expect(403);
      expect(res.body.code).toBe('2fa_required');
    });

    it('regenerating backup codes needs the password and a fresh code and invalidates the old set', async () => {
      const staff = await makeStaff('regen', 'CONTENT_MANAGER');
      const s = await staffLogin(staff, -1);
      await call('post', '/auth/2fa/backup-codes', { token: s.tokens.accessToken, body: { password: 'wrong password!!', code: code(staff.secret, 0) } }).expect(401);
      const res = await call('post', '/auth/2fa/backup-codes', { token: s.tokens.accessToken, body: { password: staff.password, code: code(staff.secret, 0) } }).expect(200);
      expect(res.body.backupCodes).toHaveLength(10);
      expect(await prisma.twoFactorBackupCode.count({ where: { userId: staff.id, usedAt: null } })).toBe(10);
    });

    it('customers never go through staff 2FA', async () => {
      const u = await makeCustomer('no2fa');
      const res = await call('post', '/auth/login', { body: { email: u.email, password: u.password } }).expect(200);
      expect(res.body.status).toBe('authenticated');
    });
  });

  /* ==================================== RBAC ==================================== */

  describe('permission-protected admin endpoints', () => {
    it('requires authentication, rejects customers, and audits the denial', async () => {
      await call('get', '/admin/audit-logs').expect(401);
      const customer = await makeCustomer('denied');
      const { tokens: t } = await login(customer);
      for (const url of ['/admin/audit-logs', '/admin/roles', '/admin/staff']) {
        const res = await call('get', url, { token: t.accessToken }).expect(403);
        expect(res.body.code).toBe('forbidden');
      }
      expect(await prisma.auditLog.count({ where: { actorUserId: customer.id, action: 'auth.permission_denied' } })).toBeGreaterThanOrEqual(3);
    });

    it('grants each endpoint exactly to the roles that hold its permission', async () => {
      const required: Record<string, string> = { '/admin/audit-logs': 'audit:read', '/admin/roles': 'roles:read', '/admin/staff': 'staff:read' };
      for (const role of ROLE_KEYS) {
        const staff = await makeStaff(`rbac-${role.toLowerCase()}`, role);
        const s = await staffLogin(staff, 0);
        for (const [url, permission] of Object.entries(required)) {
          const expected = s.user.permissions.includes(permission) ? 200 : 403;
          const res = await call('get', url, { token: s.tokens.accessToken });
          expect({ role, url, status: res.status }).toEqual({ role, url, status: expected });
        }
      }
    });

    it('applies role changes immediately, without waiting for the token to expire', async () => {
      const staff = await makeStaff('revoked', 'SUPER_ADMIN');
      const s = await staffLogin(staff, 0);
      await call('get', '/admin/roles', { token: s.tokens.accessToken }).expect(200);
      await prisma.userRole.deleteMany({ where: { userId: staff.id } });
      await call('get', '/admin/roles', { token: s.tokens.accessToken }).expect(403);
    });

    it('serves audit logs with filters and pagination, never exposing secrets', async () => {
      const staff = await makeStaff('auditor', 'SUPER_ADMIN');
      const s = await staffLogin(staff, 0);
      const all = await call('get', '/admin/audit-logs?pageSize=5', { token: s.tokens.accessToken }).expect(200);
      expect(all.body.items.length).toBeLessThanOrEqual(5);
      expect(all.body.meta.total).toBeGreaterThan(5);
      const mine = await call('get', `/admin/audit-logs?actorUserId=${staff.id}&action=auth.login`, { token: s.tokens.accessToken }).expect(200);
      expect(mine.body.items.length).toBeGreaterThan(0);
      expect(mine.body.items.every((e: { action: string; actor: { id: string } }) => e.action.startsWith('auth.login') && e.actor.id === staff.id)).toBe(true);
      const text = JSON.stringify(all.body) + JSON.stringify(mine.body);
      expect(text).not.toContain(STRONG);
      expect(text).not.toMatch(/\$argon2/);
      await call('get', '/admin/audit-logs?pageSize=1000', { token: s.tokens.accessToken }).expect(400);
      await call('get', '/admin/audit-logs?from=yesterday-ish', { token: s.tokens.accessToken }).expect(400);
    });

    it('lists roles with member counts and staff with their two-factor state', async () => {
      const staff = await makeStaff('lister', 'SUPER_ADMIN');
      const s = await staffLogin(staff, 0);
      const roles = await call('get', '/admin/roles', { token: s.tokens.accessToken }).expect(200);
      expect(roles.body.map((r: { key: string }) => r.key).sort()).toEqual([...ROLE_KEYS].sort());
      const superAdmin = roles.body.find((r: { key: string }) => r.key === 'SUPER_ADMIN');
      expect(superAdmin.permissions.length).toBeGreaterThan(90);
      expect(superAdmin.userCount).toBeGreaterThanOrEqual(1);
      const list = await call('get', `/admin/staff?q=${encodeURIComponent(staff.email.slice(0, 20))}`, { token: s.tokens.accessToken }).expect(200);
      expect(list.body.items.every((i: { email: string }) => typeof i.email === 'string')).toBe(true);
      expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|twoFactorSecret/);
    });
  });

  /* ================================ audit trail ================================ */

  describe('audit trail', () => {
    it('records the security-relevant events of a full account lifecycle', async () => {
      const u = await makeCustomer('trail');
      const { tokens: t } = await login(u);
      await call('post', '/auth/change-password', { token: t.accessToken, body: { currentPassword: u.password, newPassword: NEW_STRONG } }).expect(200);
      await call('post', '/auth/logout', { token: t.accessToken }).expect(204);
      const actions = (await prisma.auditLog.findMany({ where: { actorUserId: u.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['auth.login_success', 'auth.password_changed', 'auth.logout']));
      const row = await prisma.auditLog.findFirstOrThrow({ where: { actorUserId: u.id, action: 'auth.login_success' } });
      expect(row).toMatchObject({ entityType: 'User', entityId: u.id, actorType: 'USER' });
      expect(row.requestId).toBeTruthy();
      expect(row.ipAddress).toMatch(/^10\./); // the visitor's address forwarded by our own web server
    });
  });

  /* ================================= API docs ================================= */

  describe('OpenAPI documentation', () => {
    it('is published (outside production) and describes auth, validation and security schemes from the real schemas', async () => {
      const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
      const doc = res.body;
      expect(doc.openapi).toMatch(/^3\.1/);
      expect(doc.components.securitySchemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
      expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/admin/audit-logs', '/api/v1/public/packages']));
      const body = doc.paths['/api/v1/auth/register'].post.requestBody.content['application/json'].schema;
      expect(body.required).toEqual(expect.arrayContaining(['email', 'password', 'acceptTerms']));
      const params = doc.paths['/api/v1/admin/audit-logs'].get.parameters.map((p: { name: string }) => p.name);
      expect(params).toEqual(expect.arrayContaining(['actorUserId', 'action', 'page', 'pageSize']));
      await request(app.getHttpServer()).get('/api/docs').expect(200);
    });
  });
});
