import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { callAsUser, type ApiResult } from '@/lib/auth/server';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Calls a `/me/*` endpoint as the signed-in customer. */
export const portal = <T>(path: string, opts: { method?: Method; body?: unknown } = {}): Promise<ApiResult<T>> => callAsUser<T>(`/me${path}`, opts);

/** For pages: returns data, or turns failures into the right page (sign-in, 404, error boundary). */
export async function portalData<T>(path: string): Promise<T> {
  const res = await portal<T>(path);
  if (res.ok) return res.data;
  if (res.status === 401) redirect('/login');
  // Not verified yet: there is no customer record to show. The dashboard explains and offers to resend the link.
  if (res.status === 403 && res.error.code === 'email_unverified') redirect('/account');
  if (res.status === 404 || res.status === 400) notFound();
  throw new Error(res.error.message);
}
