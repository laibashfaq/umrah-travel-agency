import { Global, Module } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { FieldEncryption } from './field-encryption';

/** Application-level encryption for TOTP secrets and (from Phase 5) passport/CNIC numbers. */
@Global()
@Module({
  providers: [
    {
      provide: FieldEncryption,
      inject: [ENV],
      useFactory: (env: Env) => new FieldEncryption(env.FIELD_ENCRYPTION_KEY, env.FIELD_HASH_KEY),
    },
  ],
  exports: [FieldEncryption],
})
export class CryptoModule {}
