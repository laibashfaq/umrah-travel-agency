import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '../../auth/auth.types';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    user?: AuthUser;
  }
}

/** Correlates a request across logs, audit entries and error responses. Honours a well-formed inbound id. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const id = typeof inbound === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(inbound) ? inbound : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const isInternal = (req: Request, key: string | undefined): boolean => {
  const provided = req.headers['x-internal-key'];
  if (!key || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The end-user's IP. When our own Next.js server calls the API (authenticated by the internal key) it forwards the
 * visitor's address in `x-client-ip`; otherwise the connection's address is used. The header is ignored without the key,
 * so clients cannot spoof it.
 */
export function clientIp(req: Request, internalKey: string | undefined): string | null {
  if (isInternal(req, internalKey)) {
    const forwarded = req.headers['x-client-ip'];
    if (typeof forwarded === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(forwarded)) return forwarded;
  }
  return req.ip ?? null;
}

export function clientContext(req: Request, internalKey: string | undefined): ClientContext {
  const ua = req.headers['user-agent'];
  return {
    ip: clientIp(req, internalKey),
    userAgent: typeof ua === 'string' ? ua.slice(0, 255) : null,
    requestId: req.requestId ?? null,
  };
}
