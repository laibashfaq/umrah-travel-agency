/**
 * Creates (or resets) a staff account from the command line, e.g. for the first admin of a new deployment.
 *
 *   npm run staff:create -w @umrah/api -- --email ali@agency.com --role BOOKING_MANAGER --first Ali --last Khan
 *
 * Without --password a strong temporary password is generated and printed once. The person must enrol an
 * authenticator app on first sign-in (staff two-factor authentication is enforced by the API).
 *
 * --test-2fa (never in production) switches two-factor on with a known secret and prints it, so automated browser
 * tests can sign in without the enrolment screens.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { checkPassword, PASSWORD_ISSUE_MESSAGE, ROLE_KEYS, type RoleKey } from '@umrah/shared';
import { generateTotpSecret } from '../src/auth/totp';
import { FieldEncryption } from '../src/common/crypto/field-encryption';
import { PrismaClient } from '../src/generated/prisma/client';

loadEnv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const role = arg('role') as RoleKey | undefined;
  const firstName = arg('first') ?? 'Staff';
  const lastName = arg('last') ?? 'Member';
  if (!email || !role || !ROLE_KEYS.includes(role)) {
    console.error(`Usage: --email <email> --role <${ROLE_KEYS.join('|')}> [--first <name>] [--last <name>] [--password <password>]`);
    process.exit(1);
  }
  const test2fa = process.argv.includes('--test-2fa');
  if (test2fa && process.env.NODE_ENV === 'production') throw new Error('--test-2fa is not allowed in production.');
  const generated = !arg('password');
  const password = arg('password') ?? `${randomBytes(9).toString('base64url')}-${randomBytes(9).toString('base64url')}`;
  const issues = checkPassword(password, [email, firstName, lastName]);
  if (issues.length) {
    console.error(`Password rejected: ${issues.map((i) => PASSWORD_ISSUE_MESSAGE[i]).join('; ')}`);
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    const roleRow = await prisma.role.findUnique({ where: { key: role } });
    if (!roleRow) throw new Error(`Role ${role} not found. Run the seed first (npm run db:seed).`);
    const twoFactor = test2fa ? (() => { const secret = generateTotpSecret(); return { secret, enc: new FieldEncryption(process.env.FIELD_ENCRYPTION_KEY!, process.env.FIELD_HASH_KEY!).encrypt(secret) }; })() : null;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.type !== 'STAFF') throw new Error(`${email} belongs to a customer account; use a different address.`);

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { passwordHash, status: 'ACTIVE', deletedAt: null, failedLoginCount: 0, lockedUntil: null, twoFactorEnabled: test2fa, twoFactorSecretEnc: twoFactor?.enc ?? null, twoFactorLastStep: null, passwordChangedAt: new Date() },
        })
      : await prisma.user.create({ data: { email, firstName, lastName, type: 'STAFF', status: 'ACTIVE', passwordHash, emailVerifiedAt: new Date(), passwordChangedAt: new Date(), twoFactorEnabled: test2fa, twoFactorSecretEnc: twoFactor?.enc ?? null } });

    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: user.id } }),
      prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } }),
      prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'staff_reset' } }),
      prisma.twoFactorBackupCode.deleteMany({ where: { userId: user.id } }),
    ]);
    await prisma.auditLog.create({
      data: { actorType: 'SYSTEM', action: existing ? 'staff.reset_via_cli' : 'staff.created_via_cli', entityType: 'User', entityId: user.id, metadata: { role, email } },
    });

    console.log(`✓ ${existing ? 'Reset' : 'Created'} ${role} account: ${email}`);
    if (twoFactor) console.log(`  Two-factor secret: ${twoFactor.secret}`);
    if (generated) console.log(`  Temporary password: ${password}\n  (shown once; two-factor setup is required at first sign-in)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
