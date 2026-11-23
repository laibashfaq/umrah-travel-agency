import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { ResetPasswordForm } from '@/components/auth/auth-forms';
import { Alert, AlertDescription } from '@/components/ui/alert';

export const metadata = { title: 'Choose a new password' };

type Props = { searchParams: Promise<{ token?: string }> };

export default async function ResetPasswordPage({ searchParams }: Props) {
  const { token } = await searchParams;
  if (!token || token.length < 20 || token.length > 200) {
    return (
      <AuthCard title="Link not valid" footer={<Link href="/forgot-password" className="font-medium text-primary hover:underline">Request a new link</Link>}>
        <Alert variant="destructive"><AlertDescription>This password reset link is incomplete. Please request a new one.</AlertDescription></Alert>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password" description="You will be signed out of all your devices.">
      <ResetPasswordForm token={token} />
    </AuthCard>
  );
}
