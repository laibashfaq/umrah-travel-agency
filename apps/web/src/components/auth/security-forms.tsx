'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Copy } from 'lucide-react';
import { changePasswordAction, regenerateBackupCodesAction } from '@/app/(admin)/admin/security/actions';
import type { FormState } from '@/app/(auth)/actions';
import { FormMessage, SubmitButton } from '@/components/auth/auth-forms';
import { FormField, PasswordInput } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { checkPassword, PASSWORD_ISSUE_MESSAGE } from '@umrah/shared';

const initial: FormState = {};

export function ChangePasswordForm({ identity }: { identity: string[] }) {
  const [state, action] = useActionState(changePasswordAction, initial);
  const [value, setValue] = React.useState('');
  const issues = value ? checkPassword(value, identity) : [];
  const f = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid max-w-md gap-4" noValidate>
      <FormMessage state={state} />
      <FormField label="Current password" error={f.currentPassword}><PasswordInput name="currentPassword" autoComplete="current-password" /></FormField>
      <div className="grid gap-1.5">
        <FormField label="New password" error={f.newPassword}><PasswordInput name="newPassword" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} /></FormField>
        {!f.newPassword && issues.length > 0 && <ul className="space-y-0.5 text-xs text-muted-foreground">{issues.map((i) => <li key={i}>• {PASSWORD_ISSUE_MESSAGE[i]}</li>)}</ul>}
      </div>
      <SubmitButton pending="Saving…" className="w-auto">Change password</SubmitButton>
    </form>
  );
}

export function BackupCodesForm() {
  const [state, action] = useActionState(regenerateBackupCodesAction, initial);
  const f = state.fieldErrors ?? {};
  return (
    <div className="grid max-w-md gap-4">
      <form action={action} className="grid gap-4" noValidate>
        <FormMessage state={state} />
        <FormField label="Password" error={f.password}><PasswordInput name="password" autoComplete="current-password" /></FormField>
        <FormField label="Authenticator code" error={f.code} hint="A fresh 6-digit code is required."><Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="tracking-[0.3em]" /></FormField>
        <SubmitButton variant="outline" pending="Generating…" className="w-auto">Generate new backup codes</SubmitButton>
      </form>
      {state.backupCodes && (
        <div className="grid gap-3">
          <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 font-mono text-sm" aria-label="New backup codes">
            {state.backupCodes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <Button type="button" variant="outline" className="w-fit" onClick={() => void navigator.clipboard.writeText(state.backupCodes!.join('\n'))}><Copy /> Copy codes</Button>
        </div>
      )}
    </div>
  );
}
