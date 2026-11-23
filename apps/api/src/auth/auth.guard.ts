import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@umrah/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { IS_PUBLIC, PERMISSIONS_KEY, USER_TYPES_KEY } from './decorators';
import type { UserKind } from './auth.types';
import { TokenService } from './token.service';

/**
 * Default-deny authentication and authorisation for every route.
 *  - Routes marked @Public() are open.
 *  - Everything else needs a valid Bearer access token whose login (family) is still active; the user, status and
 *    permissions are re-read from the database on each request, so suspensions and role changes apply immediately.
 *  - @UserTypes() / @RequirePermissions() then restrict by kind and by permission.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException({ message: 'Please sign in to continue.', code: 'unauthenticated' });
    }
    const claims = this.tokens.verifyAccess(header.slice(7));
    const user = await this.auth.authenticateFamily(claims.sub, claims.fid);
    if (!user || user.type !== claims.typ) {
      throw new UnauthorizedException({ message: 'Your session has expired. Please sign in again.', code: 'session_invalid' });
    }
    req.user = user;

    const types = this.reflector.getAllAndOverride<UserKind[] | undefined>(USER_TYPES_KEY, targets);
    const required = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(PERMISSIONS_KEY, targets);
    const typeAllowed = !types || types.includes(user.type);
    const permitted = !required?.length || (user.type === 'STAFF' && required.every((p) => user.permissions.has(p)));
    if (!typeAllowed || !permitted) {
      await this.audit.record({
        action: 'auth.permission_denied',
        entityType: 'Route',
        entityId: `${req.method} ${req.route?.path ?? req.path}`,
        actorUserId: user.id,
        metadata: { required: required ?? null, userTypes: types ?? null },
        ...this.audit.context(req),
        ip: this.audit.context(req).ip,
      });
      throw new ForbiddenException({ message: 'You do not have permission to do this.', code: 'forbidden' });
    }
    return true;
  }
}
