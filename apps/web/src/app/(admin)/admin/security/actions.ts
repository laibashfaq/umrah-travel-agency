'use server';

import { revalidatePath } from 'next/cache';
import { changePasswordSchema, twoFactorManageSchema, type SessionInfo } from '@umrah/shared';
import type { FormState } from '@/app/(auth)/actions';
import { callAsUser } from '@/lib/auth/server';

const str = (fd: FormData, k: string): string => (typeof fd.get(k) === 'string' ? (fd.get(k) as string) : '');

function fields(issues: { path: PropertyKey[]; message: string }[]): FormState {
  const fieldErrors: Record<string, string> = {};
  for (const i of issues) fieldErrors[String(i.path[0] ?? '_')] ??= i.message;
  return { error: 'Please check the highlighted fields.', fieldErrors };
}

function apiFields(errors?: { field: string; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors ?? []) out[e.field] ??= e.message;
  return out;
}

export async function changePasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = changePasswordSchema.safeParse({ currentPassword: str(fd, 'currentPassword'), newPassword: str(fd, 'newPassword') });
  if (!parsed.success) return fields(parsed.error.issues);
  const res = await callAsUser('/auth/change-password', { method: 'POST', body: parsed.data });
  if (!res.ok) {
    const fieldErrors = apiFields(res.error.errors);
    if (res.error.code === 'invalid_credentials') fieldErrors.currentPassword = res.error.message;
    return { error: Object.keys(fieldErrors).length ? 'Please check the highlighted fields.' : res.error.message, fieldErrors };
  }
  revalidatePath('/admin/security');
  return { ok: true, message: 'Password changed. Your other devices were signed out.' };
}

export async function regenerateBackupCodesAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = twoFactorManageSchema.safeParse({ password: str(fd, 'password'), code: str(fd, 'code').replace(/\s/g, '') });
  if (!parsed.success) return fields(parsed.error.issues);
  const res = await callAsUser<{ backupCodes: string[] }>('/auth/2fa/backup-codes', { method: 'POST', body: parsed.data });
  if (!res.ok) return { error: res.error.message };
  return { ok: true, message: 'New backup codes generated. The old ones no longer work.', backupCodes: res.data.backupCodes };
}

export async function revokeSessionAction(fd: FormData): Promise<void> {
  const id = str(fd, 'id');
  if (id) await callAsUser(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  revalidatePath('/admin/security');
}

export async function signOutOtherDevicesAction(): Promise<void> {
  const list = await callAsUser<SessionInfo[]>('/auth/sessions');
  if (list.ok) {
    for (const s of list.data.filter((x) => !x.current)) await callAsUser(`/auth/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
  }
  revalidatePath('/admin/security');
}
