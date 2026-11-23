import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { TwoFactorSetupStart } from '@umrah/shared';
import { FieldEncryption } from '../common/crypto/field-encryption';
import { sha256 } from '../common/crypto/token';
import { PrismaService } from '../prisma/prisma.service';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp';

const BACKUP_CODE_COUNT = 10;
const normaliseBackup = (code: string): string => code.replace(/[\s-]/g, '').toUpperCase();

/** TOTP enrolment/verification and one-time backup codes. Secrets are encrypted at rest; codes are hashed. */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: FieldEncryption,
  ) {}

  /** Generates a pending secret (2FA stays disabled until a code is confirmed). */
  async beginSetup(user: { id: string; email: string }, issuer: string): Promise<TwoFactorSetupStart> {
    // Reload-safe: while enrolment is pending, hand back the same secret so an already-scanned QR code stays valid.
    const pending = await this.prisma.user.findUnique({ where: { id: user.id }, select: { twoFactorSecretEnc: true, twoFactorEnabled: true } });
    if (pending?.twoFactorSecretEnc && !pending.twoFactorEnabled) {
      const existing = this.enc.decrypt(pending.twoFactorSecretEnc);
      return { secret: existing, otpauthUri: otpauthUri(existing, user.email, issuer) };
    }
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { twoFactorSecretEnc: this.enc.encrypt(secret), twoFactorEnabled: false, twoFactorLastStep: null } });
    return { secret, otpauthUri: otpauthUri(secret, user.email, issuer) };
  }

  /** Confirms enrolment with a first valid code, enables 2FA and returns fresh backup codes (shown once). */
  async confirmSetup(userId: string, code: string, nowMs = Date.now()): Promise<string[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { twoFactorSecretEnc: true, twoFactorEnabled: true } });
    if (!user?.twoFactorSecretEnc || user.twoFactorEnabled) throw new BadRequestException('Two-factor setup was not started');
    const step = verifyTotp(this.enc.decrypt(user.twoFactorSecretEnc), code, nowMs, null);
    if (step === null) throw new BadRequestException({ message: 'That code is not correct. Check your authenticator app and try again.', code: 'invalid_code' });
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true, twoFactorLastStep: step } });
    return this.regenerateBackupCodes(userId);
  }

  /** Verifies an authenticator code once: a time-step can never be accepted twice (replay protection). */
  async verifyCode(userId: string, code: string, nowMs = Date.now()): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { twoFactorSecretEnc: true, twoFactorEnabled: true, twoFactorLastStep: true } });
    if (!user?.twoFactorEnabled || !user.twoFactorSecretEnc) return false;
    const step = verifyTotp(this.enc.decrypt(user.twoFactorSecretEnc), code, nowMs, user.twoFactorLastStep);
    if (step === null) return false;
    const claimed = await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ twoFactorLastStep: null }, { twoFactorLastStep: { lt: step } }] },
      data: { twoFactorLastStep: step },
    });
    return claimed.count === 1;
  }

  /** Burns a backup code. Atomic: two concurrent attempts cannot both succeed. */
  async verifyBackupCode(userId: string, code: string): Promise<boolean> {
    const claimed = await this.prisma.twoFactorBackupCode.updateMany({
      where: { userId, codeHash: sha256(normaliseBackup(code)), usedAt: null },
      data: { usedAt: new Date() },
    });
    return claimed.count === 1;
  }

  async regenerateBackupCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => {
      const raw = base32Encode(randomBytes(7)).slice(0, 10); // ~50 bits
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    await this.prisma.$transaction([
      this.prisma.twoFactorBackupCode.deleteMany({ where: { userId } }),
      this.prisma.twoFactorBackupCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(normaliseBackup(c)) })) }),
    ]);
    return codes;
  }

  async remainingBackupCodes(userId: string): Promise<number> {
    return this.prisma.twoFactorBackupCode.count({ where: { userId, usedAt: null } });
  }

  async disable(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecretEnc: null, twoFactorLastStep: null } }),
      this.prisma.twoFactorBackupCode.deleteMany({ where: { userId } }),
    ]);
  }
}
