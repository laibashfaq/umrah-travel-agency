import Link from 'next/link';
import type { InvoiceDto, Paginated } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { Forbidden } from '@/components/auth/forbidden';
import { DataTable, type Column } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { NativeSelect } from '@/components/forms/native-select';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminData, qs, staffPage } from '@/lib/admin/api';
import { formatDate, formatMoney } from '@/lib/format';
import { getStatusMeta } from '@/lib/status';

export const metadata = { title: 'Invoices' };

const STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'REFUNDED'] as const;

export default async function AdminInvoicesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const { allowed } = await staffPage('invoices:read');
  if (!allowed) return <Forbidden what="invoices" />;
  const sp = await searchParams;
  const result = await adminData<Paginated<InvoiceDto>>(`/invoices${qs({ q: sp.q, status: sp.status, page: sp.page, pageSize: 20 })}`);
  const columns: Column<InvoiceDto>[] = [
    { key: 'number', header: 'Invoice', cell: (i) => <Link className="font-medium underline-offset-4 hover:underline" href={`/admin/invoices/${i.id}`}>{i.number}</Link> },
    { key: 'customer', header: 'Customer', cell: (i) => <>{i.customer.name}<span className="block text-xs text-muted-foreground">{i.bookingReference}</span></> },
    { key: 'date', header: 'Issued', hideOnMobile: true, cell: (i) => (i.issueDate ? formatDate(i.issueDate) : '—') },
    { key: 'status', header: 'Status', cell: (i) => <StatusBadge domain="invoice" value={i.status} /> },
    { key: 'total', header: 'Total', align: 'end', cell: (i) => formatMoney(i.total, i.currency) },
    { key: 'due', header: 'Balance', align: 'end', cell: (i) => formatMoney(i.balanceDue, i.currency) },
  ];
  return (
    <>
      <PageHeader title="Invoices" description="Created automatically when a customer submits a booking." />
      <form method="get" role="search" aria-label="Filter invoices" className="mb-6 grid gap-3 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-medium">Search<Input name="q" defaultValue={sp.q} placeholder="Number, booking or customer" /></label>
        <label className="grid gap-1 text-sm font-medium">Status<NativeSelect name="status" defaultValue={sp.status ?? ''}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{getStatusMeta('invoice', s).label}</option>)}</NativeSelect></label>
        <Button type="submit">Apply</Button>
      </form>
      <DataTable caption="Invoices" columns={columns} rows={result.items} rowKey={(i) => i.id} empty={{ title: 'No invoices match' }} />
      <Pager basePath="/admin/invoices" params={{ q: sp.q, status: sp.status }} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
