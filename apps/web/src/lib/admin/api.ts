import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { callAsUser, can, requireUser, type ApiResult } from '@/lib/auth/server';
import type { PermissionKey, SessionUser } from '@umrah/shared';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Calls an `/admin/*` endpoint as the signed-in staff member. */
export const admin = <T>(path: string, opts: { method?: Method; body?: unknown } = {}): Promise<ApiResult<T>> => callAsUser<T>(`/admin${path}`, opts);

/** For pages: returns data or turns the failure into the right page. */
export async function adminData<T>(path: string): Promise<T> {
  const res = await admin<T>(path);
  if (res.ok) return res.data;
  if (res.status === 401) redirect('/login');
  if (res.status === 404 || res.status === 400) notFound();
  throw new Error(res.error.message);
}

/** Signed-in staff plus whether they hold `permission`. Pages render <Forbidden/> when `allowed` is false; the API enforces it too. */
export async function staffPage(permission: PermissionKey): Promise<{ user: SessionUser; allowed: boolean }> {
  const { user } = await requireUser('STAFF');
  return { user, allowed: can(user, permission) };
}

/** Builds `?a=1&b=2` from defined values only. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
