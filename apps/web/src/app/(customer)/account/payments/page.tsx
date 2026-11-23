import Link from 'next/link';
import { Wallet } from 'lucide-react';
import type { PaymentDto } from '@umrah/shared';
import { DataTable, type Column } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney, humanize } from '@/lib/format';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Payments' };

export default async function PaymentsPage() {
  const payments = await portalData<PaymentDto[]>('/payments');
  const columns: Column<PaymentDto>[] = [
    { key: 'ref', header: 'Payment', cell: (p) => <>{p.reference}<span className="block text-xs text-muted-foreground">{p.transactionRef ? `Ref ${p.transactionRef}` : humanize(p.method)}</span></> },
    { key: 'booking', header: 'Booking', cell: (p) => <Link className="underline-offset-4 hover:underline" href={`/account/bookings/${p.bookingId}`}>{p.bookingReference}</Link> },
    { key: 'date', header: 'Paid on', hideOnMobile: true, cell: (p) => (p.paidOn ? formatDate(p.paidOn) : '—') },
    { key: 'status', header: 'Status', cell: (p) => <><StatusBadge domain="payment" value={p.status} />{p.status === 'FAILED' && p.failureMessage && <span className="mt-1 block max-w-56 text-xs text-muted-foreground">{p.failureMessage}</span>}</> },
    { key: 'amount', header: 'Amount', align: 'end', cell: (p) => formatMoney(p.amount, p.currency) },
  ];
  return (
    <>
      <PageHeader title="Payments" description="Payments you have told us about and their status." />
      {payments.length === 0 ? (
        <EmptyState icon={Wallet} title="No payments yet" description="Open one of your bookings to see how to pay and to tell us once you have." action={<Button asChild><Link href="/account/bookings">My bookings</Link></Button>} />
      ) : (
        <DataTable caption="Your payments" columns={columns} rows={payments} rowKey={(p) => p.id} />
      )}
    </>
  );
}
