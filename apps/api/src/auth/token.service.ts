import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { durationToSeconds, hmacSha256, randomToken } from '../common/crypto/token';
import type { AccessClaims, FlowClaims, FlowPurpose, UserKind } from './auth.types';

const ISSUER = 'umrah-api';
const AUDIENCE_ACCESS = 'umrah-web';
const AUDIENCE_FLOW = 'umrah-auth-flow';

@Injectable()
export class TokenService {
  readonly accessTtlSeconds: number;
  readonly refreshTtlMs: number;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.accessTtlSeconds = durationToSeconds(env.JWT_ACCESS_TTL);
    this.refreshTtlMs = env.JWT_REFRESH_TTL_DAYS * 86_400_000;
  }

  /* ---------------------------- access tokens ---------------------------- */

  signAccess(userId: string, type: UserKind, familyId: string, now = Date.now()): { token: string; expiresAt: Date } {
    const claims: AccessClaims = { sub: userId, typ: type, fid: familyId };
    const token = jwt.sign(claims, this.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: this.accessTtlSeconds,
      issuer: ISSUER,
      audience: AUDIENCE_ACCESS,
      // jsonwebtoken derives iat from the real clock; `now` only shapes the reported expiry.
    });
    return { token, expiresAt: new Date(now + this.accessTtlSeconds * 1000) };
  }

  verifyAccess(token: string): AccessClaims {
    try {
      const payload = jwt.verify(token, this.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE_ACCESS }) as jwt.JwtPayload;
      if (typeof payload.sub !== 'string' || typeof payload.fid !== 'string' || (payload.typ !== 'CUSTOMER' && payload.typ !== 'STAFF')) {
        throw new Error('malformed');
      }
      return { sub: payload.sub, typ: payload.typ, fid: payload.fid };
    } catch {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }
  }

  /* ------------------ short-lived tokens for multi-step login ------------------ */

  signFlow(userId: string, purpose: FlowPurpose, ttlSeconds = 300): string {
    const claims: FlowClaims = { sub: userId, purpose };
    return jwt.sign(claims, this.env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: ttlSeconds, issuer: ISSUER, audience: AUDIENCE_FLOW });
  }

  verifyFlow(token: string, purpose: FlowPurpose): FlowClaims {
    try {
      const payload = jwt.verify(token, this.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE_FLOW }) as jwt.JwtPayload;
      if (typeof payload.sub !== 'string' || payload.purpose !== purpose) throw new Error('wrong purpose');
      return { sub: payload.sub, purpose };
    } catch {
      throw new UnauthorizedException('This step has expired. Please sign in again.');
    }
  }

  /* ---------------------------- refresh tokens ---------------------------- */

  /** Opaque 256-bit token; only a keyed hash is stored. */
  newRefreshToken(now = Date.now()): { token: string; hash: string; expiresAt: Date } {
    const token = randomToken(32);
    return { token, hash: this.hashRefresh(token), expiresAt: new Date(now + this.refreshTtlMs) };
  }

  hashRefresh(token: string): string {
    return hmacSha256(this.env.JWT_REFRESH_SECRET, token);
  }
}
