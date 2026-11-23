import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { TwoFactorForm } from '@/components/auth/auth-forms';
import { readFlow } from '@/lib/auth/server';

export const metadata = { title: 'Two-factor verification' };

export default async function TwoFactorPage() {
  if (!(await readFlow('challenge'))) redirect('/login?expired=1');
  return (
    <AuthCard
      title="Two-step verification"
      description="Enter the code from your authenticator app to finish signing in."
      footer={<Link href="/login" className="font-medium text-primary hover:underline">Start over</Link>}
    >
      <TwoFactorForm />
    </AuthCard>
  );
}
