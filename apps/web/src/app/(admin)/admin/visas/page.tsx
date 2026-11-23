import Link from 'next/link';
import { VISA_STATUSES, type Paginated, type VisaDto } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { Forbidden } from '@/components/auth/forbidden';
import { DataTable, type Column } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { NativeSelect } from '@/components/forms/native-select';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminData, qs, staffPage } from '@/lib/admin/api';
import { formatDate } from '@/lib/format';
import { getStatusMeta } from '@/lib/status';

export const metadata = { title: 'Visa applications' };

export default async function AdminVisasPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; assignedOfficerId?: string; page?: string }> }) {
  const { allowed } = await staffPage('visas:read');
  if (!allowed) return <Forbidden what="visa applications" />;
  const sp = await searchParams;
  const filters = { q: sp.q, status: sp.status, assignedOfficerId: sp.assignedOfficerId };
  const [result, officers] = await Promise.all([
    adminData<Paginated<VisaDto>>(`/visas${qs({ ...filters, page: sp.page, pageSize: 20 })}`),
    adminData<{ id: string; name: string }[]>('/visas/officers'),
  ]);
  const columns: Column<VisaDto>[] = [
    { key: 'traveler', header: 'Traveler', cell: (v) => <Link className="font-medium underline-offset-4 hover:underline" href={`/admin/visas/${v.id}`}>{v.travelerName}<span className="block text-xs font-normal text-muted-foreground">{v.bookingReference} · {v.customerName}</span></Link> },
    { key: 'departs', header: 'Departs', cell: (v) => formatDate(v.departureDate) },
    { key: 'status', header: 'Status', cell: (v) => <StatusBadge domain="visa" value={v.status} /> },
    { key: 'docs', header: 'Documents', hideOnMobile: true, cell: (v) => (v.missingDocuments.length === 0 ? 'Complete' : <span className="text-warning">{v.missingDocuments.length} to approve</span>) },
    { key: 'officer', header: 'Officer', hideOnMobile: true, cell: (v) => v.assignedOfficerName ?? <span className="text-muted-foreground">Unassigned</span> },
  ];
  return (
    <>
      <PageHeader title="Visa applications" description="One application per traveler. Start them from a confirmed booking." />
      <form method="get" role="search" aria-label="Filter visa applications" className="mb-6 grid gap-3 sm:grid-cols-[1fr_12rem_12rem_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-medium">Search<Input name="q" defaultValue={sp.q} placeholder="Traveler, booking or application number" /></label>
        <label className="grid gap-1 text-sm font-medium">Status<NativeSelect name="status" defaultValue={sp.status ?? ''}><option value="">All</option>{VISA_STATUSES.map((s) => <option key={s} value={s}>{getStatusMeta('visa', s).label}</option>)}</NativeSelect></label>
        <label className="grid gap-1 text-sm font-medium">Officer<NativeSelect name="assignedOfficerId" defaultValue={sp.assignedOfficerId ?? ''}><option value="">Anyone</option><option value="none">Unassigned</option>{officers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</NativeSelect></label>
        <Button type="submit">Apply</Button>
      </form>
      <DataTable caption="Visa applications" columns={columns} rows={result.items} rowKey={(v) => v.id} empty={{ title: 'No visa applications match' }} />
      <Pager basePath="/admin/visas" params={filters} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
