import Link from 'next/link';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import type { TwoFactorSetupStart } from '@umrah/shared';
import { AuthCard } from '@/components/auth/auth-card';
import { TwoFactorSetupForm } from '@/components/auth/auth-forms';
import { authApi, readFlow } from '@/lib/auth/server';

export const metadata = { title: 'Set up two-factor authentication' };

export default async function TwoFactorSetupPage() {
  const flow = await readFlow('setup');
  if (!flow) redirect('/login?expired=1');

  const res = await authApi<TwoFactorSetupStart>('/auth/2fa/setup/start', { method: 'POST', body: { setupToken: flow.token } });
  if (!res.ok) redirect('/login?expired=1');
  // Generated here on the server so the secret is never sent to a third-party QR service.
  const qr = await QRCode.toDataURL(res.data.otpauthUri, { margin: 1, width: 200, errorCorrectionLevel: 'M' });

  return (
    <AuthCard
      title="Secure your staff account"
      description="Two-factor authentication is required for staff. It takes a minute."
      footer={<Link href="/login" className="font-medium text-primary hover:underline">Cancel</Link>}
    >
      <TwoFactorSetupForm qr={qr} secret={res.data.secret} />
    </AuthCard>
  );
}
