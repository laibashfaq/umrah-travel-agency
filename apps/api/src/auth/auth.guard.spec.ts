import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS, ROLE_KEYS, type PermissionKey } from '@umrah/shared';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from './auth.types';
import type { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { IS_PUBLIC, PERMISSIONS_KEY, USER_TYPES_KEY } from './decorators';
import type { TokenService } from './token.service';

type Meta = { public?: boolean; permissions?: PermissionKey[]; types?: string[] };

function build(user: AuthUser | null, meta: Meta) {
  const recorded: unknown[] = [];
  const reflector = {
    getAllAndOverride: (key: string) => (key === IS_PUBLIC ? meta.public : key === PERMISSIONS_KEY ? meta.permissions : key === USER_TYPES_KEY ? meta.types : undefined),
  } as unknown as Reflector;
  const tokens = { verifyAccess: () => ({ sub: 'u', typ: user?.type ?? 'STAFF', fid: 'f' }) } as unknown as TokenService;
  const auth = { authenticateFamily: async () => user } as unknown as AuthService;
  const audit = { record: async (e: unknown) => void recorded.push(e), context: () => ({ ip: '1.1.1.1', userAgent: 'jest', requestId: 'r' }) } as unknown as AuditService;
  const req: { headers: Record<string, string>; method: string; path: string; route: { path: string }; user?: AuthUser } = {
    headers: { authorization: 'Bearer token' },
    method: 'GET',
    path: '/x',
    route: { path: '/x' },
  };
  const ctx = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { guard: new AuthGuard(reflector, tokens, auth, audit), ctx, req, recorded };
}

const staff = (permissions: PermissionKey[]): AuthUser => ({
  id: 's1', type: 'STAFF', status: 'ACTIVE', email: 's@example.com', firstName: 'S', lastName: 'T', emailVerified: true,
  twoFactorEnabled: true, customerId: null, familyId: 'f', roles: [], permissions: new Set(permissions),
});
const customer: AuthUser = { ...staff([]), id: 'c1', type: 'CUSTOMER', customerId: 'cu1' };

describe('AuthGuard', () => {
  it('lets @Public routes through without a token', async () => {
    const { guard, ctx, req } = build(null, { public: true });
    (req.headers as Record<string, string>).authorization = '';
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('denies by default: missing or malformed Authorization header', async () => {
    const { guard, ctx, req } = build(staff([]), {});
    (req.headers as Record<string, string>).authorization = '';
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    (req.headers as Record<string, string>).authorization = 'Basic abc';
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token whose login (family) is no longer active', async () => {
    const { guard, ctx } = build(null, {});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('authenticates and attaches the user when no restrictions apply', async () => {
    const { guard, ctx, req } = build(customer, {});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toBe(customer);
  });

  it('enforces user type', async () => {
    await expect(build(customer, { types: ['STAFF'] }).guard.canActivate(build(customer, { types: ['STAFF'] }).ctx)).rejects.toBeInstanceOf(ForbiddenException);
    const ok = build(staff([]), { types: ['STAFF'] });
    await expect(ok.guard.canActivate(ok.ctx)).resolves.toBe(true);
  });

  it('never lets a customer through a permission-protected route and audits the denial', async () => {
    const b = build(customer, { permissions: ['audit:read'] });
    await expect(b.guard.canActivate(b.ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(b.recorded).toHaveLength(1);
    expect(b.recorded[0]).toMatchObject({ action: 'auth.permission_denied', actorUserId: 'c1' });
  });

  it('requires ALL listed permissions', async () => {
    const some = build(staff(['bookings:read']), { permissions: ['bookings:read', 'bookings:cancel'] });
    await expect(some.guard.canActivate(some.ctx)).rejects.toBeInstanceOf(ForbiddenException);
    const all = build(staff(['bookings:read', 'bookings:cancel']), { permissions: ['bookings:read', 'bookings:cancel'] });
    await expect(all.guard.canActivate(all.ctx)).resolves.toBe(true);
  });

  describe('role x permission matrix (from @umrah/shared)', () => {
    for (const role of ROLE_KEYS) {
      it(`${role}: allowed exactly the permissions it is defined with`, async () => {
        const granted = new Set(ROLE_DEFINITIONS[role].permissions);
        const user = staff([...granted]);
        const wrong: string[] = [];
        for (const permission of ALL_PERMISSIONS) {
          const b = build(user, { permissions: [permission] });
          const allowed = await b.guard.canActivate(b.ctx).then(() => true, () => false);
          if (allowed !== granted.has(permission)) wrong.push(`${permission}: expected ${granted.has(permission)}, got ${allowed}`);
        }
        expect(wrong).toEqual([]);
      });
    }

    it('least privilege holds: money, staff and settings are not reachable by sales or content roles', async () => {
      const leaked: string[] = [];
      for (const role of ['SALES_AGENT', 'CONTENT_MANAGER'] as const) {
        const user = staff(ROLE_DEFINITIONS[role].permissions);
        for (const p of ['payments:read', 'refunds:approve', 'staff:update', 'settings:update', 'audit:read', 'roles:update'] as PermissionKey[]) {
          const b = build(user, { permissions: [p] });
          const allowed = await b.guard.canActivate(b.ctx).then(() => true, () => false);
          if (allowed) leaked.push(`${role} can ${p}`);
        }
      }
      expect(leaked).toEqual([]);
    });
  });
});
