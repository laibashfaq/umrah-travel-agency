import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  checkPassword,
  PASSWORD_ISSUE_MESSAGE,
  type AuthTokens,
  type LoginInput,
  type LoginResult,
  type RegisterInput,
  type SessionInfo,
  type SessionUser,
  type TwoFactorSetupComplete,
  type TwoFactorSetupStart,
  type TwoFactorVerifyInput,
} from '@umrah/shared';
import { AuditService } from '../audit/audit.service';
import { sha256, randomToken } from '../common/crypto/token';
import type { ClientContext } from '../common/http/request-context';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import type { TokenPurpose } from '../generated/prisma/client';
import { MailerService } from '../mail/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import type { AuthUser } from './auth.types';
import { PasswordService } from './password.service';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';
import { TwoFactorService } from './two-factor.service';
import { CAN_AUTHENTICATE, toAuthUser, toSessionUser, userContextSelect } from './user-context';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 30 * 60_000;

const INVALID_CREDENTIALS = { message: 'Invalid email or password.', code: 'invalid_credentials' };
const GENERIC_REGISTER = { ok: true, message: 'If this email can be used, we have sent you a verification link.' };
const GENERIC_RESET = { ok: true, message: 'If an account exists for this email, we have sent reset instructions.' };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
    private readonly twoFactor: TwoFactorService,
    private readonly audit: AuditService,
    private readonly mail: MailerService,
    private readonly settings: SettingsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /* ============================== registration ============================== */

  async register(input: RegisterInput, ctx: ClientContext): Promise<typeof GENERIC_REGISTER> {
    const issues = checkPassword(input.password, [input.email, input.firstName, input.lastName]);
    if (issues.length) throw this.passwordError(issues);

    const [passwordHash, existing] = await Promise.all([
      this.passwords.hash(input.password), // always hashed so timing does not reveal whether the email is taken
      this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true, firstName: true, deletedAt: true } }),
    ]);

    if (existing) {
      void this.mail.sendTemplate('auth.already_registered', input.email, { firstName: existing.firstName, link: `${this.env.WEB_URL}/login` }, { userId: existing.id });
      await this.audit.record({ action: 'auth.register_duplicate', entityType: 'User', entityId: existing.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
      return GENERIC_REGISTER;
    }

    const user = await this.prisma.user.create({
      data: { email: input.email, phone: input.phone, passwordHash, type: 'CUSTOMER', status: 'PENDING_VERIFICATION', firstName: input.firstName, lastName: input.lastName, passwordChangedAt: new Date() },
      select: { id: true, email: true, firstName: true },
    });
    await this.sendVerification(user);
    await this.audit.record({ action: 'auth.register', entityType: 'User', entityId: user.id, actorUserId: user.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    return GENERIC_REGISTER;
  }

  async verifyEmail(token: string, ctx: ClientContext): Promise<{ ok: true }> {
    const userId = await this.consumeToken(token, 'EMAIL_VERIFICATION');
    if (!userId) throw new BadRequestException({ message: 'This verification link is invalid or has expired.', code: 'token_invalid' });

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
        select: { id: true, type: true, email: true, firstName: true, lastName: true, phone: true, status: true },
      });
      if (user.type === 'CUSTOMER') {
        // Attach to an existing customer record (e.g. created by staff from a lead) only now that the email is proven.
        const existing = await tx.customer.findFirst({ where: { userId: null, deletedAt: null, email: { equals: user.email, mode: 'insensitive' } }, select: { id: true } });
        if (existing) await tx.customer.update({ where: { id: existing.id }, data: { userId: user.id } });
        else if (!(await tx.customer.findUnique({ where: { userId: user.id }, select: { id: true } }))) {
          await tx.customer.create({ data: { userId: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, phone: user.phone } });
        }
      }
    });
    await this.audit.record({ action: 'auth.email_verified', entityType: 'User', entityId: userId, actorUserId: userId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    return { ok: true };
  }

  async resendVerification(email: string): Promise<typeof GENERIC_REGISTER> {
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true, firstName: true, status: true, deletedAt: true } });
    if (user && !user.deletedAt && user.status === 'PENDING_VERIFICATION') await this.sendVerification(user);
    return GENERIC_REGISTER;
  }

  /* ================================== login ================================== */

  async login(input: LoginInput, ctx: ClientContext): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, type: true, status: true, passwordHash: true, deletedAt: true, lockedUntil: true, twoFactorEnabled: true },
    });

    if (!user || !user.passwordHash || user.deletedAt) {
      await this.passwords.verifyDummy(input.password);
      await this.audit.record({ action: 'auth.login_failed', entityType: 'User', metadata: { reason: 'unknown_account', emailHash: sha256(input.email) }, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    this.assertNotLocked(user.lockedUntil);

    if (!(await this.passwords.verify(user.passwordHash, input.password))) {
      await this.registerFailure(user.id, 'bad_password', ctx);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (!CAN_AUTHENTICATE.has(user.status)) {
      await this.audit.record({ action: 'auth.login_blocked', entityType: 'User', entityId: user.id, actorUserId: user.id, metadata: { status: user.status }, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
      throw new ForbiddenException({ message: 'This account is not active. Please contact support.', code: 'account_inactive' });
    }

    if (user.type === 'STAFF') {
      const required = await this.settings.get<boolean>('security.staff2faRequired', true);
      if (user.twoFactorEnabled) return { status: 'two_factor_required', challengeToken: this.tokens.signFlow(user.id, '2fa-challenge') };
      if (required) return { status: 'two_factor_setup_required', setupToken: this.tokens.signFlow(user.id, '2fa-setup', 900) };
    }
    return this.completeLogin(user.id, ctx, 'password');
  }

  async verifyTwoFactor(input: TwoFactorVerifyInput, ctx: ClientContext): Promise<LoginResult> {
    const { sub: userId } = this.tokens.verifyFlow(input.challengeToken, '2fa-challenge');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true, deletedAt: true, lockedUntil: true } });
    if (!user || user.deletedAt || !CAN_AUTHENTICATE.has(user.status)) throw new UnauthorizedException(INVALID_CREDENTIALS);
    this.assertNotLocked(user.lockedUntil);

    const ok = input.code ? await this.twoFactor.verifyCode(userId, input.code) : await this.twoFactor.verifyBackupCode(userId, input.backupCode ?? '');
    if (!ok) {
      await this.registerFailure(userId, input.code ? 'bad_2fa_code' : 'bad_backup_code', ctx);
      throw new UnauthorizedException({ message: 'That code is not correct.', code: 'invalid_code' });
    }
    if (input.backupCode) {
      const left = await this.twoFactor.remainingBackupCodes(userId);
      await this.audit.record({ action: 'auth.backup_code_used', entityType: 'User', entityId: userId, actorUserId: userId, metadata: { remaining: left }, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    }
    return this.completeLogin(userId, ctx, input.code ? '2fa' : 'backup_code');
  }

  async startTwoFactorSetup(setupToken: string): Promise<TwoFactorSetupStart> {
    const user = await this.loadSetupUser(setupToken);
    const company = await this.settings.get<string>('company.name', 'Umrah Travel');
    return this.twoFactor.beginSetup(user, company || 'Umrah Travel');
  }

  async confirmTwoFactorSetup(setupToken: string, code: string, ctx: ClientContext): Promise<TwoFactorSetupComplete> {
    const user = await this.loadSetupUser(setupToken);
    const backupCodes = await this.twoFactor.confirmSetup(user.id, code);
    await this.audit.record({ action: 'auth.2fa_enabled', entityType: 'User', entityId: user.id, actorUserId: user.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    const result = await this.completeLogin(user.id, ctx, '2fa_setup');
    if (result.status !== 'authenticated') throw new UnauthorizedException(INVALID_CREDENTIALS);
    return { tokens: result.tokens, user: result.user, backupCodes };
  }

  /* ============================ session lifecycle ============================ */

  async refresh(refreshToken: string, ctx: ClientContext): Promise<{ tokens: AuthTokens; user: SessionUser }> {
    const { tokens, userId } = await this.sessions.refresh(refreshToken, ctx);
    const user = await this.loadSessionUser(userId, this.familyOf(tokens));
    return { tokens, user };
  }

  async logout(user: AuthUser, ctx: ClientContext): Promise<void> {
    await this.sessions.revokeFamily(user.familyId, 'logout');
    await this.audit.record({ action: 'auth.logout', entityType: 'User', entityId: user.id, actorUserId: user.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
  }

  async logoutAll(user: AuthUser, ctx: ClientContext): Promise<void> {
    const count = await this.sessions.revokeAll(user.id, 'logout_all');
    await this.audit.record({ action: 'auth.logout_all', entityType: 'User', entityId: user.id, actorUserId: user.id, metadata: { sessions: count }, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
  }

  listSessions(user: AuthUser): Promise<SessionInfo[]> {
    return this.sessions.list(user.id, user.familyId);
  }

  async revokeSession(user: AuthUser, familyId: string, ctx: ClientContext): Promise<void> {
    const owned = await this.prisma.session.findFirst({ where: { userId: user.id, familyId, revokedAt: null }, select: { id: true } });
    if (!owned) throw new BadRequestException('Session not found');
    await this.sessions.revokeFamily(familyId, 'revoked_by_user');
    await this.audit.record({ action: 'auth.session_revoked', entityType: 'User', entityId: user.id, actorUserId: user.id, metadata: { familyId }, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
  }

  me(user: AuthUser): SessionUser {
    return toSessionUser(user);
  }

  /* ================================ passwords ================================ */

  async forgotPassword(email: string, ctx: ClientContext): Promise<typeof GENERIC_RESET> {
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true, firstName: true, status: true, passwordHash: true, deletedAt: true } });
    if (user && !user.deletedAt && user.passwordHash && CAN_AUTHENTICATE.has(user.status)) {
      const token = await this.createToken(user.id, 'PASSWORD_RESET', RESET_TTL_MS);
      void this.mail.sendTemplate('auth.password_reset', user.email, { firstName: user.firstName, link: `${this.env.WEB_URL}/reset-password?token=${token}` }, { userId: user.id });
      await this.audit.record({ action: 'auth.password_reset_requested', entityType: 'User', entityId: user.id, actorUserId: user.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    } else {
      await this.passwords.verifyDummy(email); // keep timing similar
    }
    return GENERIC_RESET;
  }

  async resetPassword(token: string, password: string, ctx: ClientContext): Promise<{ ok: true }> {
    const invalid = () => new BadRequestException({ message: 'This reset link is invalid or has expired.', code: 'token_invalid' });
    // Peek first: a too-weak password must not burn the single-use link.
    const peek = await this.prisma.userToken.findUnique({ where: { tokenHash: sha256(token) }, select: { userId: true, purpose: true, usedAt: true, expiresAt: true } });
    if (!peek || peek.purpose !== 'PASSWORD_RESET' || peek.usedAt || peek.expiresAt <= new Date()) throw invalid();
    const user = await this.prisma.user.findUnique({ where: { id: peek.userId }, select: { id: true, email: true, firstName: true, lastName: true, deletedAt: true, status: true } });
    if (!user || user.deletedAt || !CAN_AUTHENTICATE.has(user.status)) throw invalid();

    const issues = checkPassword(password, [user.email, user.firstName, user.lastName]);
    if (issues.length) throw this.passwordError(issues, 'password');

    const userId = await this.consumeToken(token, 'PASSWORD_RESET'); // atomic: only one request can win
    if (!userId) throw invalid();
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await this.passwords.hash(password), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
    const revoked = await this.sessions.revokeAll(userId, 'password_reset');
    await this.audit.record({ action: 'auth.password_reset_completed', entityType: 'User', entityId: userId, actorUserId: userId, metadata: { sessionsRevoked: revoked }, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    void this.mail.sendTemplate('auth.password_changed', user.email, { firstName: user.firstName }, { userId });
    return { ok: true };
  }

  async changePassword(user: AuthUser, currentPassword: string, newPassword: string, ctx: ClientContext): Promise<{ ok: true }> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    if (!row.passwordHash || !(await this.passwords.verify(row.passwordHash, currentPassword))) {
      await this.registerFailure(user.id, 'bad_current_password', ctx);
      throw new UnauthorizedException({ message: 'Your current password is not correct.', code: 'invalid_credentials' });
    }
    const issues = checkPassword(newPassword, [user.email, user.firstName, user.lastName]);
    if (issues.length) throw this.passwordError(issues, 'newPassword');
    if (await this.passwords.verify(row.passwordHash, newPassword)) throw new BadRequestException({ message: 'Choose a password you have not used before.', errors: [{ field: 'newPassword', message: 'Choose a password you have not used before.' }] });

    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await this.passwords.hash(newPassword), passwordChangedAt: new Date() } });
    const revoked = await this.sessions.revokeAll(user.id, 'password_changed', user.familyId);
    await this.audit.record({ action: 'auth.password_changed', entityType: 'User', entityId: user.id, actorUserId: user.id, metadata: { otherSessionsRevoked: revoked }, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    void this.mail.sendTemplate('auth.password_changed', user.email, { firstName: user.firstName }, { userId: user.id });
    return { ok: true };
  }

  /* ============================ 2FA management ============================ */

  async regenerateBackupCodes(user: AuthUser, password: string, code: string, ctx: ClientContext): Promise<string[]> {
    await this.reauthenticate(user, password, code, ctx);
    const codes = await this.twoFactor.regenerateBackupCodes(user.id);
    await this.audit.record({ action: 'auth.backup_codes_regenerated', entityType: 'User', entityId: user.id, actorUserId: user.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    return codes;
  }

  async disableTwoFactor(user: AuthUser, password: string, code: string, ctx: ClientContext): Promise<{ ok: true }> {
    if (user.type === 'STAFF' && (await this.settings.get<boolean>('security.staff2faRequired', true))) {
      throw new ForbiddenException({ message: 'Two-factor authentication is required for staff accounts.', code: '2fa_required' });
    }
    await this.reauthenticate(user, password, code, ctx);
    await this.twoFactor.disable(user.id);
    await this.audit.record({ action: 'auth.2fa_disabled', entityType: 'User', entityId: user.id, actorUserId: user.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    return { ok: true };
  }

  /* ================================= internals ================================= */

  /** Loads the principal for an access token's login family (used by AuthGuard). */
  async authenticateFamily(userId: string, familyId: string): Promise<AuthUser | null> {
    const session = await this.prisma.session.findFirst({
      where: { familyId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { user: { select: userContextSelect } },
    });
    if (!session || session.user.deletedAt || !CAN_AUTHENTICATE.has(session.user.status)) return null;
    return toAuthUser(session.user, familyId);
  }

  private async loadSessionUser(userId: string, familyId: string): Promise<SessionUser> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: userContextSelect });
    return toSessionUser(toAuthUser(row, familyId));
  }

  private async completeLogin(userId: string, ctx: ClientContext, via: string): Promise<LoginResult> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ctx.ip },
      select: { id: true, type: true },
    });
    const tokens = await this.sessions.issue(user, ctx);
    await this.audit.record({ action: 'auth.login_success', entityType: 'User', entityId: userId, actorUserId: userId, metadata: { via }, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
    return { status: 'authenticated', tokens, user: await this.loadSessionUser(userId, this.familyOf(tokens)) };
  }

  /** The family id is embedded in the access token (`fid`). */
  private familyOf(tokens: AuthTokens): string {
    return this.tokens.verifyAccess(tokens.accessToken).fid;
  }

  private async loadSetupUser(setupToken: string) {
    const { sub } = this.tokens.verifyFlow(setupToken, '2fa-setup');
    const user = await this.prisma.user.findUnique({ where: { id: sub }, select: { id: true, email: true, type: true, status: true, deletedAt: true, twoFactorEnabled: true } });
    if (!user || user.deletedAt || user.type !== 'STAFF' || !CAN_AUTHENTICATE.has(user.status)) throw new UnauthorizedException(INVALID_CREDENTIALS);
    if (user.twoFactorEnabled) throw new BadRequestException({ message: 'Two-factor authentication is already set up. Sign in again.', code: '2fa_already_enabled' });
    return user;
  }

  private async reauthenticate(user: AuthUser, password: string, code: string, ctx: ClientContext): Promise<void> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    const passwordOk = row.passwordHash ? await this.passwords.verify(row.passwordHash, password) : false;
    const codeOk = passwordOk && (await this.twoFactor.verifyCode(user.id, code));
    if (!passwordOk || !codeOk) {
      await this.registerFailure(user.id, 'bad_reauthentication', ctx);
      throw new UnauthorizedException({ message: 'Your password or code is not correct.', code: 'invalid_credentials' });
    }
  }

  private assertNotLocked(lockedUntil: Date | null): void {
    if (lockedUntil && lockedUntil > new Date()) {
      throw new HttpException({ message: `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes, or reset your password.`, code: 'account_locked' }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async registerFailure(userId: string, reason: string, ctx: ClientContext): Promise<void> {
    const { failedLoginCount } = await this.prisma.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } }, select: { failedLoginCount: true } });
    const lock = failedLoginCount >= MAX_FAILED_ATTEMPTS;
    if (lock) await this.prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } });
    await this.audit.record({
      action: lock ? 'auth.account_locked' : 'auth.login_failed',
      entityType: 'User',
      entityId: userId,
      actorUserId: userId,
      metadata: { reason, attempts: failedLoginCount },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
  }

  private passwordError(issues: ReturnType<typeof checkPassword>, field = 'password'): BadRequestException {
    return new BadRequestException({
      message: 'Validation failed',
      errors: issues.map((i) => ({ field, message: PASSWORD_ISSUE_MESSAGE[i] })),
    });
  }

  /* --------------------- single-use email / reset tokens --------------------- */

  private async createToken(userId: string, purpose: TokenPurpose, ttlMs: number): Promise<string> {
    const token = randomToken(32);
    await this.prisma.$transaction([
      // Only the newest link works.
      this.prisma.userToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.userToken.create({ data: { userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } }),
    ]);
    return token;
  }

  /** Atomically marks a token used and returns its owner; null when unknown, used, expired or of another purpose. */
  private async consumeToken(token: string, purpose: TokenPurpose): Promise<string | null> {
    const row = await this.prisma.userToken.findUnique({ where: { tokenHash: sha256(token) }, select: { id: true, userId: true, purpose: true, usedAt: true, expiresAt: true } });
    if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt <= new Date()) return null;
    const claimed = await this.prisma.userToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    return claimed.count === 1 ? row.userId : null;
  }

  private async sendVerification(user: { id: string; email: string; firstName: string }): Promise<void> {
    const token = await this.createToken(user.id, 'EMAIL_VERIFICATION', VERIFY_TTL_MS);
    void this.mail.sendTemplate('auth.verify_email', user.email, { firstName: user.firstName, link: `${this.env.WEB_URL}/verify-email?token=${token}` }, { userId: user.id });
  }
}
