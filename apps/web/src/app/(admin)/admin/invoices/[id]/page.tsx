import { notFound } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import type { InvoiceDto } from '@umrah/shared';
import { VoidInvoiceDialog } from '@/components/admin/finance-panels';
import { Forbidden } from '@/components/auth/forbidden';
import { InvoiceView, PrintButton } from '@/components/finance/invoice-view';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { adminData, staffPage } from '@/lib/admin/api';
import { can } from '@/lib/auth/server';
import { getCompany } from '@/lib/public-api';

export const metadata = { title: 'Invoice' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminInvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ updated?: string }> }) {
  const { user, allowed } = await staffPage('invoices:read');
  if (!allowed) return <Forbidden what="invoices" />;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { updated } = await searchParams;
  const [invoice, company] = await Promise.all([adminData<InvoiceDto>(`/invoices/${id}`), getCompany()]);
  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title={invoice.number}
          breadcrumbs={[{ label: 'Invoices', href: '/admin/invoices' }, { label: invoice.number }]}
          actions={<div className="flex flex-wrap gap-2"><PrintButton />{can(user, 'invoices:void') && invoice.status !== 'VOID' && <VoidInvoiceDialog invoiceId={invoice.id} number={invoice.number} />}</div>}
        />
        {updated && <Alert className="mb-6 border-success/40 bg-success/10" role="status"><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">Invoice updated.</AlertDescription></Alert>}
      </div>
      <InvoiceView invoice={invoice} company={company} />
    </>
  );
}
