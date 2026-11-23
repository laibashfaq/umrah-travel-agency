import { timingSafeEqual } from 'node:crypto';
import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { clientIp } from './request-context';

/**
 * Per-IP rate limiting.
 *  - Requests from our own Next.js server carry a shared secret. Safe reads (GET) from it are exempt, because every
 *    server-rendered page would otherwise appear to come from one IP.
 *  - Mutations are never exempt. For them the limiter keys on the visitor's real IP, which the web server forwards in
 *    `x-client-ip` (trusted only together with the secret).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  @Inject(ENV) private readonly env!: Env;

  private hasInternalKey(req: Request): boolean {
    const key = this.env.INTERNAL_API_KEY;
    const provided = req.headers['x-internal-key'];
    if (!key || typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    return req.method === 'GET' && this.hasInternalKey(req);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return clientIp(req as unknown as Request, this.env.INTERNAL_API_KEY) ?? 'unknown';
  }
}
