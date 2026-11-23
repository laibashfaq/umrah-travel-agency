import Link from 'next/link';
import { CheckCircle2, Download, Files } from 'lucide-react';
import { DOCUMENT_LABEL, REQUIRED_TRAVELER_DOCUMENTS, type DocumentDto, type TravelerDto } from '@umrah/shared';
import { StatusBadge } from '@/components/data/status-badge';
import { DeleteDocumentButton, UploadDocumentForm } from '@/components/documents/document-forms';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Documents' };

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ uploaded?: string; removed?: string }> }) {
  const sp = await searchParams;
  const [documents, travelers] = await Promise.all([portalData<DocumentDto[]>('/documents'), portalData<TravelerDto[]>('/travelers')]);

  if (travelers.length === 0) {
    return (
      <>
        <PageHeader title="Documents" description="Passport scans and photos for your visa." />
        <EmptyState icon={Files} title="Add a traveler first" description="Documents belong to a traveler. Add yourself and anyone travelling with you, then upload their passport and photo here." action={<Button asChild><Link href="/account/travelers/new?returnTo=%2Faccount%2Fdocuments">Add traveler</Link></Button>} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Documents" description="Upload each traveler’s passport and photo. We check them and tell you if anything needs fixing." />
      {(sp.uploaded || sp.removed) && (
        <Alert className="mb-6 border-success/40 bg-success/10" role="status"><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">{sp.uploaded ? 'Document uploaded. We will review it shortly.' : 'Document removed.'}</AlertDescription></Alert>
      )}

      <section aria-labelledby="needed" className="mb-8 grid gap-3">
        <h2 id="needed" className="font-display text-xl font-semibold">What we need</h2>
        <ul className="grid gap-3 md:grid-cols-2">
          {travelers.map((t) => (
            <li key={t.id}>
              <Card className="gap-3 p-5">
                <h3 className="font-medium">{t.firstName} {t.lastName}</h3>
                <ul className="grid gap-2 text-sm">
                  {REQUIRED_TRAVELER_DOCUMENTS.map((type) => {
                    const mine = documents.filter((d) => d.travelerId === t.id && d.type === type);
                    const best = mine.find((d) => d.status === 'APPROVED') ?? mine.find((d) => d.status === 'PENDING_REVIEW') ?? mine[0];
                    return (
                      <li key={type} className="flex items-center justify-between gap-3">
                        <span>{DOCUMENT_LABEL[type]}</span>
                        {best ? <StatusBadge domain="document" value={best.status} /> : <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">Not uploaded</span>}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="upload" className="mb-8 grid gap-3">
        <h2 id="upload" className="font-display text-xl font-semibold">Upload a document</h2>
        <Card className="p-5"><UploadDocumentForm travelers={travelers.map((t) => ({ id: t.id, name: `${t.firstName} ${t.lastName}` }))} /></Card>
      </section>

      <section aria-labelledby="files" className="grid gap-3">
        <h2 id="files" className="font-display text-xl font-semibold">Your files</h2>
        {documents.length === 0 ? <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p> : (
          <ul className="min-w-0 divide-y rounded-xl border">
            {documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                <div className="min-w-0 max-w-full">
                  <p className="font-medium">{DOCUMENT_LABEL[d.type] ?? d.type}{d.travelerName ? ` · ${d.travelerName}` : ''}</p>
                  <p className="truncate text-muted-foreground">{d.fileName} · {kb(d.sizeBytes)} · {formatDate(d.createdAt)}{d.uploadedByStaff ? ' · added by our team' : ''}</p>
                  {d.status === 'REJECTED' && d.rejectionReason && <p className="text-destructive">Please upload again: {d.rejectionReason}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge domain="document" value={d.status} />
                  <Button asChild variant="outline" size="sm"><a href={`/account/documents/${d.id}/file`}><Download /> Download<span className="sr-only"> {d.fileName}</span></a></Button>
                  {d.status !== 'APPROVED' && !d.uploadedByStaff && <DeleteDocumentButton id={d.id} label={d.fileName} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
