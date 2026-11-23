import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { BackupCodesPanel } from '@/components/auth/auth-forms';
import { readBackupCodes } from '@/lib/auth/server';

export const metadata = { title: 'Save your backup codes' };

export default async function BackupCodesPage() {
  const saved = await readBackupCodes();
  // Reached only right after enrolment; anyone else (or a reload after continuing) just goes on their way.
  if (!saved || saved.codes.length === 0) redirect('/admin');
  return (
    <AuthCard title="You're all set" description="One last step before you continue.">
      <BackupCodesPanel codes={saved.codes} />
    </AuthCard>
  );
}
