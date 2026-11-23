import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import type { Paginated, RefundDto } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { RefundActions } from '@/components/admin/finance-panels';
import { Forbidden } from '@/components/auth/forbidden';
import { DataTable, type Column } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { NativeSelect } from '@/components/forms/native-select';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { adminData, qs, staffPage } from '@/lib/admin/api';
import { can } from '@/lib/auth/server';
import { formatDate, formatMoney } from '@/lib/format';
import { getStatusMeta } from '@/lib/status';

export const metadata = { title: 'Refunds' };

const STATUSES = ['REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED', 'FAILED'] as const;

export default async function AdminRefundsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string; notice?: string }> }) {
  const { user, allowed } = await staffPage('refunds:read');
  if (!allowed) return <Forbidden what="refunds" />;
  const sp = await searchParams;
  const result = await adminData<Paginated<RefundDto>>(`/refunds${qs({ status: sp.status, page: sp.page, pageSize: 20 })}`);
  const canApprove = can(user, 'refunds:approve');
  const columns: Column<RefundDto>[] = [
    { key: 'booking', header: 'Booking', cell: (r) => <>{can(user, 'bookings:read') ? <Link className="underline-offset-4 hover:underline" href={`/admin/bookings/${r.bookingId}`}>{r.bookingReference}</Link> : r.bookingReference}<span className="block text-xs text-muted-foreground">{r.customerName} · payment {r.paymentReference}</span></> },
    { key: 'reason', header: 'Reason', hideOnMobile: true, cell: (r) => <>{r.reason}<span className="block text-xs text-muted-foreground">Asked by {r.requestedByName ?? 'staff'} on {formatDate(r.createdAt)}{r.approvedByName ? `, decided by ${r.approvedByName}` : ''}</span></> },
    { key: 'status', header: 'Status', cell: (r) => <><StatusBadge domain="refund" value={r.status} />{r.failureMessage && <span className="mt-1 block max-w-56 text-xs text-muted-foreground">{r.failureMessage}</span>}</> },
    { key: 'amount', header: 'Amount', align: 'end', cell: (r) => formatMoney(r.amount, r.currency) },
    { key: 'act', header: <span className="sr-only">Actions</span>, cell: (r) => <RefundActions refundId={r.id} status={r.status} canApprove={canApprove} returnTo={`/admin/refunds${qs({ status: sp.status, page: sp.page })}`} /> },
  ];
  return (
    <>
      <PageHeader title="Refunds" description="Requested from a payment on the booking page. A different person approves, then marks it paid once the money has gone out." />
      {sp.notice && <Alert className="mb-6 border-success/40 bg-success/10" role="status"><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">{sp.notice}</AlertDescription></Alert>}
      <form method="get" role="search" aria-label="Filter refunds" className="mb-6 flex max-w-sm items-end gap-2">
        <label className="grid flex-1 gap-1 text-sm font-medium">Status<NativeSelect name="status" defaultValue={sp.status ?? ''}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{getStatusMeta('refund', s).label}</option>)}</NativeSelect></label>
        <Button type="submit">Apply</Button>
      </form>
      <DataTable caption="Refunds" columns={columns} rows={result.items} rowKey={(r) => r.id} empty={{ title: 'No refunds' }} />
      <Pager basePath="/admin/refunds" params={{ status: sp.status }} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
