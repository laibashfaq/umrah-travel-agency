import { randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthTokens, SessionInfo } from '@umrah/shared';
import { AuditService } from '../audit/audit.service';
import type { ClientContext } from '../common/http/request-context';
import { PrismaService } from '../prisma/prisma.service';
import type { UserKind } from './auth.types';
import { TokenService } from './token.service';
import { CAN_AUTHENTICATE } from './user-context';

/** A refresh token that was rotated moments ago may legitimately arrive twice (parallel requests); not an attack. */
const ROTATION_GRACE_MS = 10_000;
const EXPIRED = 'Your session has expired. Please sign in again.';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  /** Starts a new login (or, with `familyId`, continues one) and returns a fresh token pair. */
  async issue(user: { id: string; type: UserKind }, ctx: ClientContext, familyId: string = randomUUID()): Promise<AuthTokens> {
    const refresh = this.tokens.newRefreshToken();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        familyId,
        refreshTokenHash: refresh.hash,
        userAgent: ctx.userAgent,
        ipAddress: ctx.ip,
        expiresAt: refresh.expiresAt,
        lastUsedAt: new Date(),
      },
    });
    return this.pair(user, familyId, refresh.token, refresh.expiresAt);
  }

  private pair(user: { id: string; type: UserKind }, familyId: string, refreshToken: string, refreshExpiresAt: Date): AuthTokens {
    const access = this.tokens.signAccess(user.id, user.type, familyId);
    return {
      accessToken: access.token,
      refreshToken,
      accessExpiresAt: access.expiresAt.toISOString(),
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  /**
   * Rotates a refresh token. Presenting a token that was already rotated (outside the grace window) means it was
   * stolen or replayed, so the whole login (token family) is revoked.
   */
  async refresh(presented: string, ctx: ClientContext): Promise<{ tokens: AuthTokens; userId: string }> {
    const row = await this.prisma.session.findUnique({
      where: { refreshTokenHash: this.tokens.hashRefresh(presented) },
      include: { user: { select: { id: true, type: true, status: true, deletedAt: true } } },
    });
    if (!row) throw new UnauthorizedException({ message: EXPIRED, code: 'session_invalid' });

    if (row.revokedAt) {
      if (row.revokedReason === 'rotated') {
        if (Date.now() - row.revokedAt.getTime() < ROTATION_GRACE_MS) {
          throw new UnauthorizedException({ message: 'Please retry', code: 'refresh_race' });
        }
        await this.revokeFamily(row.familyId, 'reuse_detected');
        await this.audit.record({
          action: 'auth.refresh_token_reuse',
          entityType: 'User',
          entityId: row.userId,
          actorUserId: row.userId,
          metadata: { familyId: row.familyId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        });
      }
      throw new UnauthorizedException({ message: EXPIRED, code: 'session_invalid' });
    }
    if (row.expiresAt <= new Date()) throw new UnauthorizedException({ message: EXPIRED, code: 'session_invalid' });
    if (row.user.deletedAt || !CAN_AUTHENTICATE.has(row.user.status)) {
      await this.revokeFamily(row.familyId, 'account_inactive');
      throw new UnauthorizedException({ message: EXPIRED, code: 'session_invalid' });
    }

    const next = this.tokens.newRefreshToken();
    const now = new Date();
    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'rotated', lastUsedAt: now } });
      if (claimed.count !== 1) return false; // lost a race with another refresh of the same token
      await tx.session.create({
        data: { userId: row.userId, familyId: row.familyId, refreshTokenHash: next.hash, userAgent: ctx.userAgent ?? row.userAgent, ipAddress: ctx.ip ?? row.ipAddress, expiresAt: next.expiresAt, lastUsedAt: now },
      });
      return true;
    });
    if (!rotated) throw new UnauthorizedException({ message: 'Please retry', code: 'refresh_race' });

    return { tokens: this.pair(row.user, row.familyId, next.token, next.expiresAt), userId: row.userId };
  }

  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const res = await this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return res.count;
  }

  /** Signs the user out everywhere, optionally keeping the current device. */
  async revokeAll(userId: string, reason: string, exceptFamilyId?: string): Promise<number> {
    const res = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return res.count;
  }

  async list(userId: string, currentFamilyId: string): Promise<SessionInfo[]> {
    const rows = await this.prisma.session.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({
      id: r.familyId,
      current: r.familyId === currentFamilyId,
      userAgent: r.userAgent,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt.toISOString(),
    }));
  }
}
