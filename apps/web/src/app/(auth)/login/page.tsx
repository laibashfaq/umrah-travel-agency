import Link from 'next/link';
import { CheckCircle2, Info } from 'lucide-react';
import { AuthCard } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/auth-forms';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { safeNextPath } from '@/lib/auth/config';
import { redirectIfSignedIn } from '@/lib/auth/server';

export const metadata = { title: 'Sign in' };

type Props = { searchParams: Promise<{ next?: string; reset?: string; expired?: string }> };

export default async function LoginPage({ searchParams }: Props) {
  await redirectIfSignedIn();
  const sp = await searchParams;
  const next = safeNextPath(sp.next, '') || undefined;
  return (
    <AuthCard
      title="Welcome back"
      description="Sign in to manage your bookings and documents."
      footer={<>New here? <Link href="/register" className="font-medium text-primary hover:underline">Create an account</Link></>}
    >
      {sp.reset && (
        <Alert role="status" className="border-success/40 bg-success/10"><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">Your password was updated. Sign in with the new one.</AlertDescription></Alert>
      )}
      {sp.expired && (
        <Alert role="status"><Info /><AlertDescription>That step expired. Please sign in again.</AlertDescription></Alert>
      )}
      <LoginForm next={next} />
    </AuthCard>
  );
}
