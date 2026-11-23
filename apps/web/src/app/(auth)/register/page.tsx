import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { RegisterForm } from '@/components/auth/auth-forms';
import { redirectIfSignedIn } from '@/lib/auth/server';

export const metadata = { title: 'Create your account' };

export default async function RegisterPage() {
  await redirectIfSignedIn();
  return (
    <AuthCard
      title="Create your account"
      description="Book packages, upload documents securely and track your visa."
      footer={<>Already registered? <Link href="/login" className="font-medium text-primary hover:underline">Sign in</Link></>}
    >
      <RegisterForm />
    </AuthCard>
  );
}
