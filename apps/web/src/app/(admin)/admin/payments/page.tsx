import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import type { Paginated, PaymentDto } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { VerifyButtons } from '@/components/admin/finance-panels';
import { Forbidden } from '@/components/auth/forbidden';
import { DataTable, type Column } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { NativeSelect } from '@/components/forms/native-select';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminData, qs, staffPage } from '@/lib/admin/api';
import { can } from '@/lib/auth/server';
import { formatDate, formatMoney, humanize } from '@/lib/format';
import { getStatusMeta } from '@/lib/status';

export const metadata = { title: 'Payments' };

const STATUSES = ['AWAITING_VERIFICATION', 'SUCCESSFUL', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

export default async function AdminPaymentsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string; notice?: string }> }) {
  const { user, allowed } = await staffPage('payments:read');
  if (!allowed) return <Forbidden what="payments" />;
  const sp = await searchParams;
  const result = await adminData<Paginated<PaymentDto>>(`/payments${qs({ q: sp.q, status: sp.status, page: sp.page, pageSize: 20 })}`);
  const canVerify = can(user, 'payments:verify');
  const columns: Column<PaymentDto>[] = [
    { key: 'ref', header: 'Payment', cell: (p) => <>{p.reference}<span className="block text-xs text-muted-foreground">{humanize(p.method)}{p.transactionRef ? ` · ref ${p.transactionRef}` : ''}</span></> },
    { key: 'booking', header: 'Booking', cell: (p) => <>{can(user, 'bookings:read') ? <Link className="underline-offset-4 hover:underline" href={`/admin/bookings/${p.bookingId}`}>{p.bookingReference}</Link> : p.bookingReference}<span className="block text-xs text-muted-foreground">{p.customerName}</span></> },
    { key: 'date', header: 'Paid on', hideOnMobile: true, cell: (p) => (p.paidOn ? formatDate(p.paidOn) : '—') },
    { key: 'status', header: 'Status', cell: (p) => <><StatusBadge domain="payment" value={p.status} />{p.failureMessage && <span className="mt-1 block max-w-56 text-xs text-muted-foreground">{p.failureMessage}</span>}</> },
    { key: 'amount', header: 'Amount', align: 'end', cell: (p) => formatMoney(p.amount, p.currency) },
    { key: 'act', header: <span className="sr-only">Actions</span>, cell: (p) => (p.status === 'AWAITING_VERIFICATION' && canVerify ? <VerifyButtons paymentId={p.id} amount={formatMoney(p.amount, p.currency)} returnTo={`/admin/payments${qs({ q: sp.q, status: sp.status, page: sp.page })}`} /> : p.verifiedByName ? <span className="text-xs text-muted-foreground">Checked by {p.verifiedByName}</span> : null) },
  ];
  return (
    <>
      <PageHeader title="Payments" description="Money customers say they have paid, and money your team has recorded. Check each against the bank before verifying." />
      {sp.notice && <Alert className="mb-6 border-success/40 bg-success/10" role="status"><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">{sp.notice}</AlertDescription></Alert>}
      <form method="get" role="search" aria-label="Filter payments" className="mb-6 grid gap-3 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-medium">Search<Input name="q" defaultValue={sp.q} placeholder="Payment, booking, customer" /></label>
        <label className="grid gap-1 text-sm font-medium">Status<NativeSelect name="status" defaultValue={sp.status ?? ''}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{getStatusMeta('payment', s).label}</option>)}</NativeSelect></label>
        <Button type="submit">Apply</Button>
      </form>
      <DataTable caption="Payments" columns={columns} rows={result.items} rowKey={(p) => p.id} empty={{ title: 'No payments match' }} />
      <Pager basePath="/admin/payments" params={{ q: sp.q, status: sp.status }} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
