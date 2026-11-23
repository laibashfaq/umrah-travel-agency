import type { ApiFailure } from '@/lib/auth/server';

export interface PortalFormState {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Non-sensitive values to put back into the form after a failed save (React clears uncontrolled fields). */
  values?: Record<string, string>;
}

export const str = (fd: FormData, key: string): string => (typeof fd.get(key) === 'string' ? (fd.get(key) as string) : '');

export function apiFail(error: ApiFailure, values?: Record<string, string>): PortalFormState {
  const fieldErrors: Record<string, string> = {};
  for (const e of error.errors ?? []) if (typeof e === 'object' && e && 'field' in e) fieldErrors[String(e.field)] ??= String(e.message);
  const hasFields = Object.keys(fieldErrors).length > 0;
  return { error: hasFields ? 'Please check the highlighted fields.' : error.message, fieldErrors, values };
}

export function zodFail(issues: { path: PropertyKey[]; message: string }[], values?: Record<string, string>): PortalFormState {
  const fieldErrors: Record<string, string> = {};
  for (const i of issues) fieldErrors[String(i.path[0] ?? '_')] ??= i.message;
  return { error: 'Please check the highlighted fields.', fieldErrors, values };
}

/** All string fields of a form, for putting back after an error. */
export function snapshot(fd: FormData, exclude: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$') && !exclude.includes(k)) out[k] = v;
  return out;
}
