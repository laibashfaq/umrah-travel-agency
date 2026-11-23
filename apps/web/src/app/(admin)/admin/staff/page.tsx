import type { Paginated } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { Forbidden } from '@/components/auth/forbidden';
import { DataTable, type Column } from '@/components/data/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminData, qs, staffPage } from '@/lib/admin/api';
import { formatDateTime, humanize } from '@/lib/format';

export const metadata = { title: 'Staff' };

interface StaffRow {
  id: string;
  email: string;
  name: string;
  status: string;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  roles: { key: string; name: string }[];
}

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const { allowed } = await staffPage('staff:read');
  if (!allowed) return <Forbidden what="staff accounts" />;
  const sp = await searchParams;
  const result = await adminData<Paginated<StaffRow>>(`/staff${qs({ q: sp.q, page: sp.page, pageSize: 25 })}`);
  const columns: Column<StaffRow>[] = [
    { key: 'name', header: 'Name', cell: (s) => <>{s.name}<span className="block text-xs text-muted-foreground">{s.email}</span></> },
    { key: 'roles', header: 'Role', cell: (s) => <span className="flex flex-wrap gap-1">{s.roles.map((r) => <Badge key={r.key} variant="secondary">{r.name}</Badge>)}</span> },
    { key: 'status', header: 'Status', cell: (s) => humanize(s.status) },
    { key: '2fa', header: 'Two-factor', hideOnMobile: true, cell: (s) => (s.twoFactorEnabled ? 'On' : <span className="text-warning">Not set up yet</span>) },
    { key: 'last', header: 'Last sign-in', hideOnMobile: true, cell: (s) => (s.lastLoginAt ? formatDateTime(s.lastLoginAt) : 'Never') },
  ];
  return (
    <>
      <PageHeader title="Staff" description="People who can sign in to the staff portal. Create accounts from the server with the staff:create command." />
      <form method="get" role="search" aria-label="Search staff" className="mb-6 flex max-w-xl items-end gap-2">
        <label className="grid flex-1 gap-1 text-sm font-medium">Search<Input name="q" defaultValue={sp.q} placeholder="Name or email" /></label>
        <Button type="submit">Search</Button>
      </form>
      <DataTable caption="Staff accounts" columns={columns} rows={result.items} rowKey={(s) => s.id} empty={{ title: 'No staff found' }} />
      <Pager basePath="/admin/staff" params={{ q: sp.q }} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
