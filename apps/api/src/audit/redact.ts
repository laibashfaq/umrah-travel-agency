/**
 * Removes secrets before anything is written to the audit trail. Matching is by key name, so new sensitive
 * fields are covered by naming them sensibly (password, token, passport, cnic, ...).
 */
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|cookie|passport|national|cnic|card|cvv|otp|backup|hash|encrypt|signature|apikey|api_key)/i;
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

export const REDACTED = '[REDACTED]';

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    // Class instances (Prisma Decimal, etc.) are rendered through toString().
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== null && proto !== Object.prototype) return String(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}
