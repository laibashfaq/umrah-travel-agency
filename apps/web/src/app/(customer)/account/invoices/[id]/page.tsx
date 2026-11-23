import { notFound } from 'next/navigation';
import type { InvoiceDto } from '@umrah/shared';
import { InvoiceView, PrintButton } from '@/components/finance/invoice-view';
import { PageHeader } from '@/components/layout/page-header';
import { getCompany } from '@/lib/public-api';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Invoice' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [invoice, company] = await Promise.all([portalData<InvoiceDto>(`/invoices/${id}`), getCompany()]);
  return (
    <>
      <div className="print:hidden">
        <PageHeader title={invoice.number} breadcrumbs={[{ label: 'Invoices', href: '/account/invoices' }, { label: invoice.number }]} actions={<PrintButton />} />
      </div>
      <InvoiceView invoice={invoice} company={company} />
    </>
  );
}
