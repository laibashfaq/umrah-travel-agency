import { z } from 'zod';
import type { PermissionKey, RoleKey } from './rbac';

/* ------------------------------------------------------------------ */
/* Password policy                                                     */
/* ------------------------------------------------------------------ */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Very common passwords that satisfy length rules (lower-case, compared after normalising). */
const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', 'passw0rd1234', 'qwertyuiop12', 'qwerty123456', '123456789012', '1234567890123',
  'admin1234567', 'administrator', 'welcome12345', 'letmein12345', 'iloveyou1234', 'changeme1234', 'umrah1234567',
  'bismillah123', 'muhammad1234', 'pakistan1234', 'karachi12345', 'lahore123456', 'islamabad123', 'abcdefghijkl',
  'abc123456789', '111111111111', '000000000000', 'aaaaaaaaaaaa', 'password!234', 'p@ssw0rd1234', 'p@ssword1234',
]);

export type PasswordIssue = 'too_short' | 'too_long' | 'too_common' | 'repetitive' | 'contains_identity';

/** Pure policy check shared by API and web. `identity` strings (email, name) must not appear inside the password. */
export function checkPassword(password: string, identity: string[] = []): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push('too_short');
  if (password.length > PASSWORD_MAX_LENGTH) issues.push('too_long');
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) issues.push('too_common');
  if (/^(.)\1+$/.test(password) || new Set(password).size < 5) issues.push('repetitive');
  for (const id of identity) {
    const part = id.toLowerCase().split('@')[0] ?? '';
    if (part.length >= 4 && lowered.includes(part)) {
      issues.push('contains_identity');
      break;
    }
  }
  return issues;
}

export const PASSWORD_ISSUE_MESSAGE: Record<PasswordIssue, string> = {
  too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters`,
  too_long: `Use at most ${PASSWORD_MAX_LENGTH} characters`,
  too_common: 'This password is too common. Choose something harder to guess',
  repetitive: 'Avoid repeated characters',
  contains_identity: 'Do not include your name or email in your password',
};

/** Password field: length, common-password and repetition rules (identity checks happen where the identity is known). */
export const passwordSchema = z
  .string()
  .max(PASSWORD_MAX_LENGTH + 64) // hard stop for abuse; the policy message below covers the real limit
  .superRefine((value, ctx) => {
    for (const issue of checkPassword(value)) {
      ctx.addIssue({ code: 'custom', message: PASSWORD_ISSUE_MESSAGE[issue] });
    }
  });

/* ------------------------------------------------------------------ */
/* Request schemas                                                     */
/* ------------------------------------------------------------------ */

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address'));
const name = z.string().trim().min(1, 'Required').max(80);
const otp = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');
const backupCode = z.string().trim().min(8).max(24);

export const registerSchema = z.object({
  firstName: name,
  lastName: name,
  email,
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^\+?[0-9\s\-()]{7,30}$/, 'Enter a valid phone number')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  password: passwordSchema,
  acceptTerms: z.literal(true, { error: 'Please accept the terms and privacy policy' }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({ email, password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH + 64) });
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });
export type RefreshInput = z.infer<typeof refreshSchema>;

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });
export const resendVerificationSchema = z.object({ email });
export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });

export const twoFactorVerifySchema = z
  .object({ challengeToken: z.string().min(20).max(2000), code: otp.optional(), backupCode: backupCode.optional() })
  .refine((v) => Boolean(v.code) !== Boolean(v.backupCode), { message: 'Enter either an authenticator code or a backup code', path: ['code'] });
export const twoFactorSetupStartSchema = z.object({ setupToken: z.string().min(20).max(2000) });
export const twoFactorSetupConfirmSchema = z.object({ setupToken: z.string().min(20).max(2000), code: otp });
export const twoFactorManageSchema = z.object({ password: z.string().min(1).max(200), code: otp });

export type TwoFactorVerifyInput = z.infer<typeof twoFactorVerifySchema>;

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export type UserKind = 'CUSTOMER' | 'STAFF';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamps; clients refresh shortly before `accessExpiresAt`. */
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  type: UserKind;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  customerId: string | null;
  roles: { key: RoleKey | string; name: string }[];
  /** Effective staff permissions (empty for customers). Used by the UI to hide what the API would reject. */
  permissions: PermissionKey[];
}

export type LoginResult =
  | { status: 'authenticated'; tokens: AuthTokens; user: SessionUser }
  | { status: 'two_factor_required'; challengeToken: string }
  | { status: 'two_factor_setup_required'; setupToken: string };

export interface TwoFactorSetupStart {
  /** Base32 secret to type into an authenticator app. */
  secret: string;
  /** `otpauth://` URI for QR codes. */
  otpauthUri: string;
}

export interface TwoFactorSetupComplete {
  tokens: AuthTokens;
  user: SessionUser;
  /** Shown exactly once. */
  backupCodes: string[];
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface AuditLogEntryDto {
  id: string;
  createdAt: string;
  actorType: 'USER' | 'SYSTEM' | 'WEBHOOK';
  actor: { id: string; name: string; email: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  ipAddress: string | null;
  requestId: string | null;
}

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  permissions: string[];
}
