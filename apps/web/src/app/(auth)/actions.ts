'use server';

import { redirect } from 'next/navigation';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  twoFactorSetupConfirmSchema,
  twoFactorVerifySchema,
  type LoginResult,
  type TwoFactorSetupComplete,
} from '@umrah/shared';
import { destinationFor } from '@/lib/auth/config';
import { authApi, clearBackupCodesCookie, clearFlowCookie, readBackupCodes, readFlow, setBackupCodesCookie, setFlowCookie, setSessionCookies, type ApiFailure } from '@/lib/auth/server';

export interface FormState {
  ok?: boolean;
  /** Success text for forms that stay on the page. */
  message?: string;
  /** Page-level error. */
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Non-sensitive values to put back into the form (React clears uncontrolled fields after every action). Never passwords. */
  values?: Record<string, string>;
  /** Shown exactly once after two-factor enrolment. */
  backupCodes?: string[];
  continueTo?: string;
}

const str = (fd: FormData, k: string): string => (typeof fd.get(k) === 'string' ? (fd.get(k) as string) : '');

const keep = (state: FormState, values: Record<string, string>): FormState => ({ ...state, values });

function failure(error: ApiFailure, fallbackField?: string): FormState {
  const fieldErrors: Record<string, string> = {};
  for (const e of error.errors ?? []) fieldErrors[e.field] ??= e.message;
  if (fallbackField && !Object.keys(fieldErrors).length && error.code === 'invalid_code') fieldErrors[fallbackField] = error.message;
  return { error: Object.keys(fieldErrors).length ? 'Please check the highlighted fields.' : error.message, fieldErrors };
}

function zodFields(issues: { path: PropertyKey[]; message: string }[]): FormState {
  const fieldErrors: Record<string, string> = {};
  for (const i of issues) fieldErrors[String(i.path[0] ?? '_')] ??= i.message;
  return { error: 'Please check the highlighted fields.', fieldErrors };
}

/* ------------------------------ sign in ------------------------------ */

export async function loginAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({ email: str(fd, 'email'), password: str(fd, 'password') });
  const email = str(fd, 'email');
  if (!parsed.success) return keep(zodFields(parsed.error.issues), { email });
  const next = str(fd, 'next') || undefined;

  const res = await authApi<LoginResult>('/auth/login', { method: 'POST', body: parsed.data });
  if (!res.ok) return keep(failure(res.error), { email });

  const result = res.data;
  if (result.status === 'authenticated') {
    await setSessionCookies(result.tokens, result.user.type);
    redirect(destinationFor(result.user.type, next));
  }
  if (result.status === 'two_factor_required') {
    await setFlowCookie({ kind: 'challenge', token: result.challengeToken, next });
    redirect('/login/two-factor');
  }
  await setFlowCookie({ kind: 'setup', token: result.setupToken, next });
  redirect('/login/two-factor/setup');
}

export async function twoFactorAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const flow = await readFlow('challenge');
  if (!flow) redirect('/login');
  const useBackup = str(fd, 'mode') === 'backup';
  const parsed = twoFactorVerifySchema.safeParse({
    challengeToken: flow.token,
    ...(useBackup ? { backupCode: str(fd, 'backupCode') } : { code: str(fd, 'code').replace(/\s/g, '') }),
  });
  if (!parsed.success) return zodFields(parsed.error.issues.map((i) => ({ ...i, path: [useBackup ? 'backupCode' : 'code'] })));

  const res = await authApi<LoginResult>('/auth/2fa/verify', { method: 'POST', body: parsed.data });
  if (!res.ok) {
    // The challenge expires after five minutes or too many attempts; start over in that case.
    if (res.status === 401 && res.error.code !== 'invalid_code') {
      await clearFlowCookie();
      redirect('/login?expired=1');
    }
    return failure(res.error, useBackup ? 'backupCode' : 'code');
  }
  if (res.data.status !== 'authenticated') redirect('/login');
  await setSessionCookies(res.data.tokens, res.data.user.type);
  redirect(destinationFor(res.data.user.type, flow.next));
}

export async function twoFactorSetupAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const flow = await readFlow('setup');
  if (!flow) redirect('/login');
  const parsed = twoFactorSetupConfirmSchema.safeParse({ setupToken: flow.token, code: str(fd, 'code').replace(/\s/g, '') });
  if (!parsed.success) return zodFields(parsed.error.issues);

  const res = await authApi<TwoFactorSetupComplete>('/auth/2fa/setup/confirm', { method: 'POST', body: parsed.data });
  if (!res.ok) {
    if (res.status === 401) {
      await clearFlowCookie();
      redirect('/login?expired=1');
    }
    return failure(res.error, 'code');
  }
  await setSessionCookies(res.data.tokens, res.data.user.type);
  // Setting cookies makes Next re-render this page, which would no longer find its setup cookie. So the one-time
  // backup codes are shown on their own page, reached by redirect, from a short-lived path-scoped cookie.
  await setBackupCodesCookie(res.data.backupCodes, destinationFor(res.data.user.type, flow.next));
  redirect('/login/two-factor/done');
}

/** "I have saved them": forget the codes and continue to the portal. */
export async function finishTwoFactorSetupAction(): Promise<void> {
  const saved = await readBackupCodes();
  await clearBackupCodesCookie();
  redirect(saved?.continueTo ?? '/admin');
}

/* ----------------------------- registration ----------------------------- */

export async function registerAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = registerSchema.safeParse({
    firstName: str(fd, 'firstName'),
    lastName: str(fd, 'lastName'),
    email: str(fd, 'email'),
    phone: str(fd, 'phone'),
    password: str(fd, 'password'),
    acceptTerms: fd.get('acceptTerms') === 'on',
  });
  const values = { firstName: str(fd, 'firstName'), lastName: str(fd, 'lastName'), email: str(fd, 'email'), phone: str(fd, 'phone') };
  if (!parsed.success) return keep(zodFields(parsed.error.issues), values);
  const res = await authApi<{ message: string }>('/auth/register', { method: 'POST', body: parsed.data });
  if (!res.ok) return keep(failure(res.error), values);
  return { ok: true, message: res.data.message };
}

export async function resendVerificationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = str(fd, 'email');
  if (!email) return { error: 'Missing email address.' };
  const res = await authApi<{ message: string }>('/auth/resend-verification', { method: 'POST', body: { email } });
  return res.ok ? { ok: true, message: 'If your email still needs verifying, we have sent a new link.' } : failure(res.error);
}

export async function verifyEmailAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const token = str(fd, 'token');
  const res = await authApi('/auth/verify-email', { method: 'POST', body: { token } });
  return res.ok ? { ok: true, message: 'Your email address is verified.' } : failure(res.error);
}

/* ------------------------------- passwords ------------------------------- */

export async function forgotPasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = forgotPasswordSchema.safeParse({ email: str(fd, 'email') });
  const values = { email: str(fd, 'email') };
  if (!parsed.success) return keep(zodFields(parsed.error.issues), values);
  const res = await authApi<{ message: string }>('/auth/forgot-password', { method: 'POST', body: parsed.data });
  return res.ok ? { ok: true, message: res.data.message } : keep(failure(res.error), values);
}

export async function resetPasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = resetPasswordSchema.safeParse({ token: str(fd, 'token'), password: str(fd, 'password') });
  if (!parsed.success) return zodFields(parsed.error.issues);
  const res = await authApi('/auth/reset-password', { method: 'POST', body: parsed.data });
  if (!res.ok) return failure(res.error);
  redirect('/login?reset=1');
}

