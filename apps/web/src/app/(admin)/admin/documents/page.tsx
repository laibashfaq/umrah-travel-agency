import { CheckCircle2, Download } from 'lucide-react';
import { DOCUMENT_LABEL, STAFF_DOCUMENT_TYPES, type DocumentDto, type Paginated } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { ReviewDocumentButtons } from '@/components/admin/visa-panels';
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
import { formatDate } from '@/lib/format';
import { getStatusMeta } from '@/lib/status';

export const metadata = { title: 'Documents' };

const STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const;

export default async function AdminDocumentsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; type?: string; page?: string; notice?: string }> }) {
  const { user, allowed } = await staffPage('documents:read');
  if (!allowed) return <Forbidden what="documents" />;
  const sp = await searchParams;
  // The queue opens on what is waiting for a person.
  const status = sp.status ?? 'PENDING_REVIEW';
  const filters = { q: sp.q, status: status === 'ALL' ? undefined : status, type: sp.type };
  const result = await adminData<Paginated<DocumentDto>>(`/documents${qs({ ...filters, page: sp.page, pageSize: 20 })}`);
  const returnTo = `/admin/documents${qs({ q: sp.q, status: sp.status, type: sp.type, page: sp.page })}`;
  const canReview = can(user, 'documents:review');
  const canDownload = can(user, 'documents:download');
  const columns: Column<DocumentDto>[] = [
    { key: 'doc', header: 'Document', cell: (d) => <>{DOCUMENT_LABEL[d.type] ?? d.type}<span className="block max-w-56 truncate text-xs text-muted-foreground">{d.fileName}</span></> },
    { key: 'who', header: 'Traveler', cell: (d) => <>{d.travelerName ?? '—'}<span className="block text-xs text-muted-foreground">{d.customerName}{d.bookingReference ? ` · ${d.bookingReference}` : ''}</span></> },
    { key: 'date', header: 'Uploaded', hideOnMobile: true, cell: (d) => formatDate(d.createdAt) },
    { key: 'status', header: 'Status', cell: (d) => <><StatusBadge domain="document" value={d.status} />{d.rejectionReason && <span className="mt-1 block max-w-56 text-xs text-muted-foreground">{d.rejectionReason}</span>}</> },
    {
      key: 'act',
      header: <span className="sr-only">Actions</span>,
      cell: (d) => (
        <div className="flex flex-wrap items-start gap-2">
          {canDownload && <Button asChild variant="outline" size="sm"><a href={`/admin/documents/${d.id}/file`}><Download /> Open<span className="sr-only"> {d.fileName}</span></a></Button>}
          {canReview && d.status === 'PENDING_REVIEW' && <ReviewDocumentButtons documentId={d.id} label={`${DOCUMENT_LABEL[d.type] ?? d.type} of ${d.travelerName ?? 'traveler'}`} returnTo={returnTo} />}
        </div>
      ),
    },
  ];
  return (
    <>
      <PageHeader title="Documents" description="Passports, photos and other files from customers. Open a file, check it, then approve or ask for a new upload. Every download is logged." />
      {sp.notice && <Alert className="mb-6 border-success/40 bg-success/10" role="status"><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">{sp.notice}</AlertDescription></Alert>}
      <form method="get" role="search" aria-label="Filter documents" className="mb-6 grid gap-3 sm:grid-cols-[1fr_12rem_14rem_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-medium">Search<Input name="q" defaultValue={sp.q} placeholder="Traveler, customer or booking" /></label>
        <label className="grid gap-1 text-sm font-medium">Status<NativeSelect name="status" defaultValue={status}><option value="ALL">All</option>{STATUSES.map((s) => <option key={s} value={s}>{getStatusMeta('document', s).label}</option>)}</NativeSelect></label>
        <label className="grid gap-1 text-sm font-medium">Type<NativeSelect name="type" defaultValue={sp.type ?? ''}><option value="">All</option>{STAFF_DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{DOCUMENT_LABEL[t]}</option>)}</NativeSelect></label>
        <Button type="submit">Apply</Button>
      </form>
      <DataTable caption="Documents" columns={columns} rows={result.items} rowKey={(d) => d.id} empty={{ title: status === 'PENDING_REVIEW' ? 'Nothing is waiting for review' : 'No documents match' }} />
      <Pager basePath="/admin/documents" params={{ q: sp.q, status: sp.status, type: sp.type }} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
