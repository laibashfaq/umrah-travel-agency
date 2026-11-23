import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, Download } from 'lucide-react';
import { DOCUMENT_LABEL, type DocumentDto, type VisaDto } from '@umrah/shared';
import { ReviewDocumentButtons, VisaAssignPanel, VisaStatusPanel } from '@/components/admin/visa-panels';
import { Forbidden } from '@/components/auth/forbidden';
import { StatusBadge } from '@/components/data/status-badge';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminData, staffPage } from '@/lib/admin/api';
import { can } from '@/lib/auth/server';
import { formatDate, formatDateTime } from '@/lib/format';
import { getStatusMeta } from '@/lib/status';

export const metadata = { title: 'Visa application' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminVisaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ updated?: string; notice?: string }> }) {
  const { user, allowed } = await staffPage('visas:read');
  if (!allowed) return <Forbidden what="visa applications" />;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const v = await adminData<VisaDto>(`/visas/${id}`);
  const canDocs = can(user, 'documents:read');
  const [officers, documents] = await Promise.all([
    adminData<{ id: string; name: string }[]>('/visas/officers'),
    canDocs ? adminData<DocumentDto[]>(`/travelers/${v.travelerId}/documents`) : Promise.resolve([] as DocumentDto[]),
  ]);

  return (
    <>
      <PageHeader
        title={v.travelerName}
        description={`Umrah visa · booking ${v.bookingReference} · departs ${formatDate(v.departureDate)}`}
        breadcrumbs={[{ label: 'Visa applications', href: '/admin/visas' }, { label: v.travelerName }]}
        actions={<StatusBadge domain="visa" value={v.status} />}
      />
      {(sp.updated || sp.notice) && <Alert className="mb-6 border-success/40 bg-success/10" role="status"><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">{sp.notice ?? 'Application updated.'}</AlertDescription></Alert>}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted-foreground">Customer</dt><dd>{v.customerName}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Booking</dt><dd>{can(user, 'bookings:read') ? <Link className="underline-offset-4 hover:underline" href={`/admin/bookings/${v.bookingId}`}>{v.bookingReference}</Link> : v.bookingReference}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Application number</dt><dd>{v.applicationNumber ?? '—'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Portal reference</dt><dd>{v.externalReference ?? '—'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Visa number</dt><dd className="font-mono">{v.visaNumber ?? '—'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Valid</dt><dd>{v.validFrom && v.validUntil ? `${formatDate(v.validFrom)} to ${formatDate(v.validUntil)}` : '—'}</dd></div>
                {v.rejectionReason && <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Rejection reason</dt><dd className="text-destructive">{v.rejectionReason}</dd></div>}
              </dl>
              <p className="mt-4 border-t pt-3 text-sm text-muted-foreground">The customer currently sees: “{v.message}”</p>
            </CardContent>
          </Card>

          {canDocs && (
            <Card className="shadow-card">
              <CardHeader><CardTitle className="text-base">Traveler documents</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                {v.missingDocuments.length > 0 && <p className="text-sm text-warning">Not yet approved: {v.missingDocuments.join(', ')}</p>}
                {documents.length === 0 ? <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p> : (
                  <ul className="min-w-0 divide-y rounded-lg border">
                    {documents.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                        <div className="min-w-0 max-w-full"><p className="font-medium">{DOCUMENT_LABEL[d.type] ?? d.type}</p><p className="truncate text-muted-foreground">{d.fileName} · {formatDate(d.createdAt)}{d.rejectionReason ? ` · ${d.rejectionReason}` : ''}</p></div>
                        <div className="flex flex-wrap items-start gap-2">
                          <StatusBadge domain="document" value={d.status} />
                          {can(user, 'documents:download') && <Button asChild variant="outline" size="sm"><a href={`/admin/documents/${d.id}/file`}><Download /> Open<span className="sr-only"> {d.fileName}</span></a></Button>}
                          {can(user, 'documents:review') && d.status === 'PENDING_REVIEW' && <ReviewDocumentButtons documentId={d.id} label={DOCUMENT_LABEL[d.type] ?? d.type} returnTo={`/admin/visas/${v.id}`} />}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
            <CardContent>
              <ol className="grid gap-2 text-sm">
                {[...v.history].reverse().map((h, i) => (
                  <li key={i} className="flex flex-wrap gap-x-3"><span className="font-medium">{getStatusMeta('visa', h.status).label}</span><span className="text-muted-foreground">{formatDateTime(h.at)}{h.note ? ` · ${h.note}` : ''}</span></li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <aside className="grid min-w-0 content-start gap-6" aria-label="Actions">
          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">Status</CardTitle></CardHeader>
            <CardContent><VisaStatusPanel key={v.status} visaId={v.id} allowed={v.allowedTransitions} canUpdate={can(user, 'visas:update')} /></CardContent>
          </Card>
          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">Assignment</CardTitle></CardHeader>
            <CardContent><VisaAssignPanel visaId={v.id} assignedOfficerId={v.assignedOfficerId} officers={officers} canAssign={can(user, 'visas:assign')} /></CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
