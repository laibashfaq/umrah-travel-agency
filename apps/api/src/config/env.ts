import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.url().default('http://localhost:4000'),
  WEB_URL: z.url().default('http://localhost:3000'),
  /** Number of reverse proxies in front of the API (0 = none). Needed for correct client IPs in rate limiting. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Shared secret the Next.js server sends on SSR requests so they bypass per-IP rate limits. */
  INTERNAL_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .pipe(z.string().min(24).optional()),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().startsWith('postgresql://'),
  REDIS_URL: z.string().startsWith('redis').default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  FIELD_ENCRYPTION_KEY: base64Key32,
  FIELD_HASH_KEY: z.string().min(32),

  AWS_REGION: z.string().default('me-central-1'),
  S3_PRIVATE_BUCKET: z.string().default('umrah-private-docs'),
  S3_PUBLIC_BUCKET: z.string().default('umrah-public-media'),
  /** `local` keeps private files on this machine's disk (development only); production uses the private S3 bucket. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.local/storage'),
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  /** `log` writes emails to a local outbox folder (development only). */
  EMAIL_PROVIDER: z.enum(['log', 'resend', 'ses']).default('log'),
  OUTBOX_DIR: z.string().default('.local/outbox'),
  /** Interactive API docs at /api/docs. Defaults to on outside production. */
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  EMAIL_FROM: z.string().default('Umrah Travel <no-reply@example.com>'),
  RESEND_API_KEY: optional,

  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_ACCESS_TOKEN: optional,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optional,
  WHATSAPP_APP_SECRET: optional,

  PAYMENT_PROVIDER: z.string().default('manual'),
  PAYMENT_WEBHOOK_SECRET: optional,
});

/** Cross-field rules that must hold before the app is allowed to boot. */
const validatedEnvSchema = envSchema.superRefine((env, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (env.EMAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY) fail('RESEND_API_KEY', 'required when EMAIL_PROVIDER=resend');
  if (env.EMAIL_PROVIDER === 'ses') fail('EMAIL_PROVIDER', 'SES is not implemented yet; use resend');
  if (env.NODE_ENV === 'production') {
    if (env.EMAIL_PROVIDER === 'log') fail('EMAIL_PROVIDER', 'the dev "log" provider cannot be used in production');
    if (env.STORAGE_DRIVER === 'local') fail('STORAGE_DRIVER', 'passports and IDs must live in the private S3 bucket in production (STORAGE_DRIVER=s3)');
    if (new Set([env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET]).size < 2) fail('JWT_REFRESH_SECRET', 'must differ from JWT_ACCESS_SECRET');
    if (/change-me/i.test(env.JWT_ACCESS_SECRET + env.JWT_REFRESH_SECRET)) fail('JWT_ACCESS_SECRET', 'placeholder secret detected');
    if (env.CORS_ORIGINS.some((o) => o.startsWith('http://') && !o.includes('localhost'))) fail('CORS_ORIGINS', 'production origins must use https');
  }
});

export type Env = z.infer<typeof envSchema>;

/** Validates process.env once at boot; fails fast with a readable list of problems. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = validatedEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
