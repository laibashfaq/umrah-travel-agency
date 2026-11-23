import Link from 'next/link';
import { ReceiptText } from 'lucide-react';
import type { InvoiceDto } from '@umrah/shared';
import { DataTable, type Column } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { formatDate, formatMoney } from '@/lib/format';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Invoices' };

export default async function InvoicesPage() {
  const invoices = await portalData<InvoiceDto[]>('/invoices');
  const columns: Column<InvoiceDto>[] = [
    { key: 'number', header: 'Invoice', cell: (i) => <Link className="font-medium underline-offset-4 hover:underline" href={`/account/invoices/${i.id}`}>{i.number}</Link> },
    { key: 'booking', header: 'Booking', hideOnMobile: true, cell: (i) => i.bookingReference },
    { key: 'date', header: 'Issued', hideOnMobile: true, cell: (i) => (i.issueDate ? formatDate(i.issueDate) : '—') },
    { key: 'status', header: 'Status', cell: (i) => <StatusBadge domain="invoice" value={i.status} /> },
    { key: 'total', header: 'Total', align: 'end', cell: (i) => formatMoney(i.total, i.currency) },
    { key: 'due', header: 'Balance due', align: 'end', cell: (i) => formatMoney(i.balanceDue, i.currency) },
  ];
  return (
    <>
      <PageHeader title="Invoices" description="One invoice for each booking. Open it to print or save a copy." />
      {invoices.length === 0 ? (
        <EmptyState icon={ReceiptText} title="No invoices yet" description="An invoice is created when you submit a booking." />
      ) : (
        <DataTable caption="Your invoices" columns={columns} rows={invoices} rowKey={(i) => i.id} />
      )}
    </>
  );
}
