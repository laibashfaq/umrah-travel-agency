import type { Metadata } from 'next';
import { PortalShell } from '@/components/layout/portal-shell';
import { requireUser } from '@/lib/auth/server';

export const metadata: Metadata = {
  title: { default: 'My account', template: '%s | My account' },
  robots: { index: false, follow: false },
};

// Never cached or prerendered: every request is checked against the API session.
export const dynamic = 'force-dynamic';

export default async function CustomerLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser('CUSTOMER');
  return (
    <PortalShell variant="customer" user={{ name: `${user.firstName} ${user.lastName}`, email: user.email }}>
      {children}
    </PortalShell>
  );
}
