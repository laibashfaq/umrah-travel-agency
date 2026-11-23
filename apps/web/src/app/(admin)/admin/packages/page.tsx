import Link from 'next/link';
import { Plus } from 'lucide-react';
import { PUBLISH_STATUSES, type AdminPackageRowDto, type Paginated } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { Forbidden } from '@/components/auth/forbidden';
import { DataTable, type Column } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { NativeSelect } from '@/components/forms/native-select';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminData, qs, staffPage } from '@/lib/admin/api';
import { can } from '@/lib/auth/server';
import { formatDate, formatMoney, humanize } from '@/lib/format';

export const metadata = { title: 'Packages' };

export default async function AdminPackagesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const { user, allowed } = await staffPage('packages:read');
  if (!allowed) return <Forbidden what="packages" />;
  const sp = await searchParams;
  const result = await adminData<Paginated<AdminPackageRowDto>>(`/packages${qs({ q: sp.q, status: sp.status, page: sp.page, pageSize: 20 })}`);
  const columns: Column<AdminPackageRowDto>[] = [
    { key: 'title', header: 'Package', cell: (p) => <Link className="font-medium underline-offset-4 hover:underline" href={`/admin/packages/${p.id}`}>{p.title}<span className="block text-xs font-normal text-muted-foreground">/packages/{p.slug}</span></Link> },
    { key: 'status', header: 'Status', cell: (p) => <StatusBadge domain="publish" value={p.status} /> },
    { key: 'tier', header: 'Tier', hideOnMobile: true, cell: (p) => `${humanize(p.tier)} · ${p.durationDays} days` },
    { key: 'departures', header: 'Open departures', hideOnMobile: true, align: 'end', cell: (p) => p.openDepartures },
    { key: 'price', header: 'From', align: 'end', cell: (p) => (p.startingPrice ? formatMoney(p.startingPrice, p.currency) : '—') },
    { key: 'updated', header: 'Updated', hideOnMobile: true, cell: (p) => formatDate(p.updatedAt) },
  ];
  return (
    <>
      <PageHeader
        title="Packages"
        description="Umrah packages shown on the website."
        actions={can(user, 'packages:create') ? <Button asChild variant="gold"><Link href="/admin/packages/new"><Plus /> New package</Link></Button> : undefined}
      />
      <form method="get" role="search" aria-label="Filter packages" className="mb-6 grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-medium">Search<Input name="q" defaultValue={sp.q} placeholder="Title or web address" /></label>
        <label className="grid gap-1 text-sm font-medium">Status<NativeSelect name="status" defaultValue={sp.status ?? ''}><option value="">All</option>{PUBLISH_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</NativeSelect></label>
        <Button type="submit">Apply</Button>
      </form>
      <DataTable caption="Packages" columns={columns} rows={result.items} rowKey={(p) => p.id} empty={{ title: 'No packages found' }} />
      <Pager basePath="/admin/packages" params={{ q: sp.q, status: sp.status }} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
