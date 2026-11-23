import type { Metadata } from 'next';
import { PortalShell } from '@/components/layout/portal-shell';
import { requireUser } from '@/lib/auth/server';

export const metadata: Metadata = {
  title: { default: 'Staff portal', template: '%s | Staff portal' },
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser('STAFF');
  return (
    <PortalShell
      variant="admin"
      permissions={user.permissions}
      user={{ name: `${user.firstName} ${user.lastName}`, email: user.email, roleLabel: user.roles.map((r) => r.name).join(', ') }}
    >
      {children}
    </PortalShell>
  );
}
