import type { PermissionKey, SessionUser } from '@umrah/shared';
import type { Prisma } from '../generated/prisma/client';
import type { AuthUser } from './auth.types';

/** Everything needed to authenticate and authorise a request in one query. */
export const userContextSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  type: true,
  status: true,
  emailVerifiedAt: true,
  twoFactorEnabled: true,
  deletedAt: true,
  customer: { select: { id: true } },
  roles: { select: { role: { select: { key: true, name: true, permissions: { select: { permission: { select: { key: true } } } } } } } },
} satisfies Prisma.UserSelect;

export type UserContextRow = Prisma.UserGetPayload<{ select: typeof userContextSelect }>;

export function toAuthUser(row: UserContextRow, familyId: string): AuthUser {
  const permissions = new Set<PermissionKey>();
  if (row.type === 'STAFF') {
    for (const r of row.roles) for (const p of r.role.permissions) permissions.add(p.permission.key as PermissionKey);
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    emailVerified: row.emailVerifiedAt !== null,
    twoFactorEnabled: row.twoFactorEnabled,
    customerId: row.customer?.id ?? null,
    familyId,
    roles: row.roles.map((r) => ({ key: r.role.key, name: r.role.name })),
    permissions,
  };
}

export function toSessionUser(u: AuthUser): SessionUser {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    type: u.type,
    status: u.status,
    emailVerified: u.emailVerified,
    twoFactorEnabled: u.twoFactorEnabled,
    customerId: u.customerId,
    roles: u.roles,
    permissions: [...u.permissions].sort(),
  };
}

/** Accounts in these states may hold a session. */
export const CAN_AUTHENTICATE = new Set(['ACTIVE', 'PENDING_VERIFICATION']);
