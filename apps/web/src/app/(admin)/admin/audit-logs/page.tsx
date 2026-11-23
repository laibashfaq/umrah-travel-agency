import type { AuditLogEntryDto, Paginated } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { Forbidden } from '@/components/auth/forbidden';
import { DataTable, type Column } from '@/components/data/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminData, qs, staffPage } from '@/lib/admin/api';
import { formatDateTime } from '@/lib/format';

export const metadata = { title: 'Audit logs' };

type Search = { action?: string; entityType?: string; entityId?: string; page?: string };

export default async function AuditLogsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { allowed } = await staffPage('audit:read');
  if (!allowed) return <Forbidden what="the audit log" />;
  const sp = await searchParams;
  const filters = { action: sp.action, entityType: sp.entityType, entityId: sp.entityId };
  const result = await adminData<Paginated<AuditLogEntryDto>>(`/audit-logs${qs({ ...filters, page: sp.page, pageSize: 30 })}`);
  const columns: Column<AuditLogEntryDto>[] = [
    { key: 'when', header: 'When', cell: (e) => <span className="whitespace-nowrap">{formatDateTime(e.createdAt)}</span> },
    { key: 'who', header: 'Who', cell: (e) => (e.actor ? <>{e.actor.name}<span className="block text-xs text-muted-foreground">{e.actor.email}</span></> : <span className="text-muted-foreground">{e.actorType === 'SYSTEM' ? 'System' : 'Unknown'}</span>) },
    { key: 'action', header: 'Action', cell: (e) => <code className="text-xs">{e.action}</code> },
    { key: 'entity', header: 'Record', hideOnMobile: true, cell: (e) => <>{e.entityType}<span className="block max-w-48 truncate font-mono text-xs text-muted-foreground">{e.entityId ?? ''}</span></> },
    { key: 'ip', header: 'IP', hideOnMobile: true, cell: (e) => e.ipAddress ?? '—' },
  ];
  return (
    <>
      <PageHeader title="Audit logs" description="Who did what, newest first. Entries can never be edited or deleted." />
      <form method="get" role="search" aria-label="Filter audit log" className="mb-6 grid gap-3 sm:grid-cols-4 sm:items-end">
        <label className="grid gap-1 text-sm font-medium">Action starts with<Input name="action" defaultValue={sp.action} placeholder="booking." /></label>
        <label className="grid gap-1 text-sm font-medium">Record type<Input name="entityType" defaultValue={sp.entityType} placeholder="Booking" /></label>
        <label className="grid gap-1 text-sm font-medium">Record id<Input name="entityId" defaultValue={sp.entityId} /></label>
        <Button type="submit">Apply</Button>
      </form>
      <DataTable caption="Audit log" columns={columns} rows={result.items} rowKey={(e) => e.id} empty={{ title: 'No entries match' }} />
      <Pager basePath="/admin/audit-logs" params={filters} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
