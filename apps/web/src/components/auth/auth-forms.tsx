'use client';

import * as React from 'react';
import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { CheckCircle2, Copy, Download, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { checkPassword, PASSWORD_ISSUE_MESSAGE } from '@umrah/shared';
import {
  finishTwoFactorSetupAction,
  forgotPasswordAction,
  loginAction,
  registerAction,
  resetPasswordAction,
  resendVerificationAction,
  twoFactorAction,
  twoFactorSetupAction,
  verifyEmailAction,
  type FormState,
} from '@/app/(auth)/actions';
import { FormField, PasswordInput } from '@/components/forms/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const initial: FormState = {};

export function SubmitButton({ children, pending: pendingLabel = 'Please wait…', variant = 'default', className }: { children: React.ReactNode; pending?: string; variant?: React.ComponentProps<typeof Button>['variant']; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" variant={variant} disabled={pending} className={cn('w-full', className)}>
      {pending ? <><Loader2 className="animate-spin" /> {pendingLabel}</> : children}
    </Button>
  );
}

export function FormMessage({ state }: { state: FormState }) {
  if (state.error) return <Alert variant="destructive" role="alert"><AlertDescription>{state.error}</AlertDescription></Alert>;
  if (state.ok && state.message) {
    return (
      <Alert role="status" className="border-success/40 bg-success/10">
        <CheckCircle2 className="text-success" />
        <AlertDescription className="text-foreground">{state.message}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

/** Live checklist driven by the same policy the API enforces. */
function PasswordHints({ value, identity }: { value: string; identity: string[] }) {
  if (!value) return <p className="text-xs text-muted-foreground">At least 12 characters. A short phrase of unrelated words works well.</p>;
  const issues = checkPassword(value, identity);
  return issues.length === 0 ? (
    <p className="text-xs font-medium text-success">Looks good.</p>
  ) : (
    <ul className="space-y-0.5 text-xs text-muted-foreground" aria-live="polite">
      {issues.map((i) => <li key={i}>• {PASSWORD_ISSUE_MESSAGE[i]}</li>)}
    </ul>
  );
}

/* ------------------------------- sign in ------------------------------- */

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState(loginAction, initial);
  const f = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      <FormMessage state={state} />
      <FormField label="Email" error={f.email}><Input name="email" type="email" autoComplete="username" inputMode="email" autoFocus required defaultValue={state.values?.email} /></FormField>
      <FormField label="Password" error={f.password}><PasswordInput name="password" autoComplete="current-password" required /></FormField>
      <div className="flex justify-end text-sm"><Link href="/forgot-password" className="font-medium text-primary hover:underline">Forgot your password?</Link></div>
      <SubmitButton pending="Signing in…">Sign in</SubmitButton>
    </form>
  );
}

export function TwoFactorForm() {
  const [state, action] = useActionState(twoFactorAction, initial);
  const [backup, setBackup] = React.useState(false);
  const f = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="mode" value={backup ? 'backup' : 'code'} />
      <FormMessage state={state} />
      {backup ? (
        <FormField label="Backup code" error={f.backupCode} hint="Each backup code works once."><Input name="backupCode" autoComplete="off" autoCapitalize="characters" autoFocus placeholder="XXXXX-XXXXX" /></FormField>
      ) : (
        <FormField label="6-digit code" error={f.code} hint="From your authenticator app."><Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} autoFocus placeholder="123456" className="tracking-[0.3em]" /></FormField>
      )}
      <SubmitButton pending="Verifying…">Verify and sign in</SubmitButton>
      <button type="button" onClick={() => setBackup((b) => !b)} className="text-sm font-medium text-primary hover:underline">
        {backup ? 'Use my authenticator app instead' : 'Use a backup code instead'}
      </button>
    </form>
  );
}

/** QR code + manual secret + first code. On success the server redirects to the one-time backup-codes page. */
export function TwoFactorSetupForm({ qr, secret }: { qr: string; secret: string }) {
  const [state, action] = useActionState(twoFactorSetupAction, initial);
  const f = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-5" noValidate>
      <ol className="grid gap-4 text-sm">
        <li className="grid gap-3">
          <span className="font-medium">1. Scan this code with an authenticator app</span>
          {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
          <img src={qr} alt="QR code for your authenticator app" width={200} height={200} className="mx-auto rounded-lg border bg-white p-2" />
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer font-medium text-primary">Can&apos;t scan? Enter the key manually</summary>
            <p className="mt-2 font-mono text-sm tracking-wider break-all select-all" data-testid="totp-secret">{secret}</p>
          </details>
        </li>
        <li className="grid gap-2">
          <span className="font-medium">2. Enter the 6-digit code it shows</span>
          <FormMessage state={state} />
          <FormField label="6-digit code" error={f.code}><Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" className="tracking-[0.3em]" /></FormField>
        </li>
      </ol>
      <SubmitButton pending="Checking…"><KeyRound /> Turn on two-factor authentication</SubmitButton>
    </form>
  );
}

/** Shown once, right after enrolment. Codes are hashed server-side and cannot be displayed again. */
export function BackupCodesPanel({ codes }: { codes: string[] }) {
  const [copied, setCopied] = React.useState(false);
  const text = codes.join('\n');
  return (
    <div className="grid gap-4">
      <Alert role="status" className="border-success/40 bg-success/10"><ShieldCheck className="text-success" /><AlertDescription className="text-foreground">Two-factor authentication is on. You are signed in.</AlertDescription></Alert>
      <div>
        <h2 className="font-sans text-base font-semibold">Save your backup codes</h2>
        <p className="mt-1 text-sm text-muted-foreground">Use one if you lose your phone. Each works once, and they will not be shown again.</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 font-mono text-sm" aria-label="Backup codes">
        {codes.map((c) => <li key={c} className="tabular-nums">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); }}><Copy /> {copied ? 'Copied' : 'Copy'}</Button>
        <Button type="button" variant="outline" asChild>
          <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(`Backup codes\n${text}\n`)}`} download="backup-codes.txt"><Download /> Download</a>
        </Button>
      </div>
      <form action={finishTwoFactorSetupAction}><SubmitButton pending="Continuing…">I have saved them. Continue</SubmitButton></form>
    </div>
  );
}

/* ------------------------------ registration ------------------------------ */

export function RegisterForm() {
  const [state, action] = useActionState(registerAction, initial);
  const [password, setPassword] = React.useState('');
  const [identity, setIdentity] = React.useState({ email: '', first: '', last: '' });
  const f = state.fieldErrors ?? {};
  const termsId = React.useId();

  if (state.ok) {
    return (
      <div className="grid gap-4 text-center">
        <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
        <h2 className="font-display text-xl font-semibold">Check your email</h2>
        <p className="text-sm text-muted-foreground">{state.message} The link is valid for 24 hours.</p>
        <Button asChild variant="outline"><Link href="/login">Go to sign in</Link></Button>
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="First name" required error={f.firstName}><Input name="firstName" autoComplete="given-name" defaultValue={state.values?.firstName} onChange={(e) => setIdentity((s) => ({ ...s, first: e.target.value }))} /></FormField>
        <FormField label="Last name" required error={f.lastName}><Input name="lastName" autoComplete="family-name" defaultValue={state.values?.lastName} onChange={(e) => setIdentity((s) => ({ ...s, last: e.target.value }))} /></FormField>
      </div>
      <FormField label="Email" required error={f.email}><Input name="email" type="email" autoComplete="email" inputMode="email" defaultValue={state.values?.email} onChange={(e) => setIdentity((s) => ({ ...s, email: e.target.value }))} /></FormField>
      <FormField label="Phone (optional)" error={f.phone}><Input name="phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+92 300 1234567" defaultValue={state.values?.phone} /></FormField>
      <div className="grid gap-1.5">
        <FormField label="Password" required error={f.password}><PasswordInput name="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></FormField>
        {!f.password && <PasswordHints value={password} identity={[identity.email, identity.first, identity.last]} />}
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-start gap-2.5">
          <Checkbox id={termsId} name="acceptTerms" className="mt-0.5" aria-invalid={f.acceptTerms ? true : undefined} />
          <Label htmlFor={termsId} className="text-sm leading-snug font-normal">
            I agree to the <Link href="/policies/terms" className="font-medium text-primary underline underline-offset-4">terms</Link> and <Link href="/policies/privacy" className="font-medium text-primary underline underline-offset-4">privacy policy</Link>.
          </Label>
        </div>
        {f.acceptTerms && <p role="alert" className="text-xs font-medium text-destructive">{f.acceptTerms}</p>}
      </div>
      <SubmitButton pending="Creating account…">Create account</SubmitButton>
    </form>
  );
}

/* -------------------------------- passwords -------------------------------- */

export function ForgotPasswordForm() {
  const [state, action] = useActionState(forgotPasswordAction, initial);
  if (state.ok) {
    return (
      <div className="grid gap-4 text-center">
        <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
        <h2 className="font-display text-xl font-semibold">Check your email</h2>
        <p className="text-sm text-muted-foreground">{state.message} The link is valid for 30 minutes.</p>
        <Button asChild variant="outline"><Link href="/login">Back to sign in</Link></Button>
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormMessage state={state} />
      <FormField label="Email" error={state.fieldErrors?.email}><Input name="email" type="email" autoComplete="email" inputMode="email" autoFocus required defaultValue={state.values?.email} /></FormField>
      <SubmitButton pending="Sending…">Send reset link</SubmitButton>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, initial);
  const [password, setPassword] = React.useState('');
  const f = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} />
      <div className="grid gap-1.5">
        <FormField label="New password" error={f.password}><PasswordInput name="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></FormField>
        {!f.password && <PasswordHints value={password} identity={[]} />}
      </div>
      <SubmitButton pending="Saving…">Set new password</SubmitButton>
    </form>
  );
}

/** Verification is a button press (POST), not a GET side effect, so email scanners that open links cannot burn the token. */
export function VerifyEmailForm({ token }: { token: string }) {
  const [state, action] = useActionState(verifyEmailAction, initial);
  if (state.ok) {
    return (
      <div className="grid gap-4 text-center">
        <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
        <h2 className="font-display text-xl font-semibold">Email verified</h2>
        <p className="text-sm text-muted-foreground">{state.message}</p>
        <Button asChild size="lg"><Link href="/login">Sign in</Link></Button>
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} />
      <SubmitButton pending="Verifying…">Verify my email address</SubmitButton>
      {state.error && <p className="text-center text-sm text-muted-foreground">Links expire after 24 hours. Sign in and request a new one from your account.</p>}
    </form>
  );
}

export function ResendVerification({ email }: { email: string }) {
  const [state, action] = useActionState(resendVerificationAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="email" value={email} />
      <SubmitButton variant="outline" pending="Sending…" className="w-auto">Resend verification email</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
