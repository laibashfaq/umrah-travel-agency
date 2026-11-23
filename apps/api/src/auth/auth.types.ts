import type { PermissionKey } from '@umrah/shared';

export type UserKind = 'CUSTOMER' | 'STAFF';

/** The authenticated principal attached to `req.user` by AuthGuard. Re-read from the database on every request. */
export interface AuthUser {
  id: string;
  type: UserKind;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  email: string;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  customerId: string | null;
  /** Refresh-token family of the current login; revoking the family signs this device out. */
  familyId: string;
  roles: { key: string; name: string }[];
  permissions: ReadonlySet<PermissionKey>;
}

export interface AccessClaims {
  sub: string;
  typ: UserKind;
  fid: string;
}

export type FlowPurpose = '2fa-challenge' | '2fa-setup';

export interface FlowClaims {
  sub: string;
  purpose: FlowPurpose;
}
