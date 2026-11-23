import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@umrah/shared';
import type { Request } from 'express';
import type { AuthUser, UserKind } from './auth.types';

export const IS_PUBLIC = 'auth:public';
export const PERMISSIONS_KEY = 'auth:permissions';
export const USER_TYPES_KEY = 'auth:userTypes';

/** Opts a route out of authentication. Everything else is private by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Staff must hold ALL listed permissions (implies staff-only). */
export const RequirePermissions = (...permissions: PermissionKey[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** Restricts a route to one or more user kinds. */
export const UserTypes = (...types: UserKind[]) => SetMetadata(USER_TYPES_KEY, types);

/** The authenticated user (never undefined on non-public routes). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return req.user as AuthUser;
});
