import { Injectable, OnModuleInit } from '@nestjs/common';
import argon2 from 'argon2';

/** Argon2id with the OWASP-recommended minimum cost (19 MiB, 2 iterations, 1 lane). */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash('timing-equaliser-not-a-real-password', OPTIONS);
  }

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /** Burns the same CPU as a real check so response time does not reveal whether an email exists. */
  async verifyDummy(plain: string): Promise<void> {
    await argon2.verify(this.dummyHash, plain).catch(() => false);
  }
}
