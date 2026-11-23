import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { VerifyEmailForm } from '@/components/auth/auth-forms';
import { Alert, AlertDescription } from '@/components/ui/alert';

export const metadata = { title: 'Verify your email' };

type Props = { searchParams: Promise<{ token?: string }> };

export default async function VerifyEmailPage({ searchParams }: Props) {
  const { token } = await searchParams;
  if (!token || token.length < 20 || token.length > 200) {
    return (
      <AuthCard title="Link not valid" footer={<Link href="/login" className="font-medium text-primary hover:underline">Go to sign in</Link>}>
        <Alert variant="destructive"><AlertDescription>This verification link is incomplete. Open the link from your email again, or sign in to request a new one.</AlertDescription></Alert>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Verify your email" description="Confirm this address to finish setting up your account.">
      <VerifyEmailForm token={token} />
    </AuthCard>
  );
}
