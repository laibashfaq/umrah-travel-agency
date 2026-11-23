import { randomBytes } from 'node:crypto';
import { loadEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  FIELD_HASH_KEY: 'c'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults and parses CORS list', () => {
    const env = loadEnv({ ...valid, CORS_ORIGINS: 'http://a.com, http://b.com' });
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://a.com', 'http://b.com']);
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it('fails fast on weak secrets and bad keys', () => {
    expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadEnv({ ...valid, FIELD_ENCRYPTION_KEY: 'abc' })).toThrow(
      /FIELD_ENCRYPTION_KEY/,
    );
    expect(() => loadEnv({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  describe('production safety rules', () => {
    const prod = { ...valid, NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', CORS_ORIGINS: 'https://example.com', STORAGE_DRIVER: 's3' };
    it('accepts a correct production configuration', () => {
      expect(() => loadEnv(prod)).not.toThrow();
    });
    it('refuses the development email logger, placeholder secrets and plain-http origins', () => {
      expect(() => loadEnv({ ...prod, EMAIL_PROVIDER: 'log' })).toThrow(/EMAIL_PROVIDER/);
      expect(() => loadEnv({ ...prod, JWT_ACCESS_SECRET: 'change-me-access-secret-min-32-chars-xxxxxxxx' })).toThrow(/placeholder/);
      expect(() => loadEnv({ ...prod, JWT_REFRESH_SECRET: valid.JWT_ACCESS_SECRET })).toThrow(/must differ/);
      expect(() => loadEnv({ ...prod, CORS_ORIGINS: 'http://example.com' })).toThrow(/https/);
    });
    it('keeps passports and IDs off the server disk in production', () => {
      expect(() => loadEnv({ ...prod, STORAGE_DRIVER: 'local' })).toThrow(/STORAGE_DRIVER/);
      expect(loadEnv({ ...valid, STORAGE_DRIVER: 'local' }).STORAGE_DRIVER).toBe('local'); // fine for development
    });
    it('requires an API key when using Resend and rejects unimplemented SES', () => {
      expect(() => loadEnv({ ...prod, RESEND_API_KEY: '' })).toThrow(/RESEND_API_KEY/);
      expect(() => loadEnv({ ...valid, EMAIL_PROVIDER: 'ses' })).toThrow(/SES/);
    });
    it('allows the dev logger outside production', () => {
      expect(loadEnv({ ...valid, EMAIL_PROVIDER: 'log' }).EMAIL_PROVIDER).toBe('log');
    });
  });
});
