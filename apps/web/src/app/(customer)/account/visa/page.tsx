import Link from 'next/link';
import { CheckCircle2, Circle, Stamp } from 'lucide-react';
import type { VisaDto, VisaStatusKey } from '@umrah/shared';
import { StatusBadge } from '@/components/data/status-badge';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import { portalData } from '@/lib/portal/api';
import { getStatusMeta } from '@/lib/status';

export const metadata = { title: 'Visa tracking' };

/** The normal path, shown as steps. Rejected and cancelled applications show their message instead. */
const STEPS: VisaStatusKey[] = ['DOCUMENTS_PENDING', 'UNDER_REVIEW', 'READY_TO_SUBMIT', 'SUBMITTED', 'IN_PROCESS', 'APPROVED', 'ISSUED'];

export default async function VisaPage() {
  const visas = await portalData<VisaDto[]>('/visas');
  return (
    <>
      <PageHeader title="Visa tracking" description="Where each traveler’s Umrah visa stands." />
      {visas.length === 0 ? (
        <EmptyState icon={Stamp} title="No visa applications yet" description="We open a visa application for each traveler once your booking is confirmed. You can upload passports and photos now so we are ready." action={<Button asChild><Link href="/account/documents">Upload documents</Link></Button>} />
      ) : (
        <ul className="grid gap-4">
          {visas.map((v) => {
            const at = STEPS.indexOf(v.status);
            return (
              <li key={v.id}>
                <Card className="gap-4 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-display text-lg font-semibold">{v.travelerName}</h2>
                      <p className="text-sm text-muted-foreground">Booking <Link className="underline-offset-4 hover:underline" href={`/account/bookings/${v.bookingId}`}>{v.bookingReference}</Link> · departs {formatDate(v.departureDate)}</p>
                    </div>
                    <StatusBadge domain="visa" value={v.status} />
                  </div>
                  <p className="text-sm">{v.message}</p>
                  {v.status === 'REJECTED' && v.rejectionReason && <p className="text-sm text-destructive">Reason: {v.rejectionReason}</p>}
                  {v.status === 'ISSUED' && (
                    <dl className="grid grid-cols-2 gap-3 rounded-lg bg-success/10 p-3 text-sm sm:grid-cols-3">
                      <div><dt className="text-xs text-muted-foreground">Visa number</dt><dd className="font-mono font-medium">{v.visaNumber}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Valid from</dt><dd>{v.validFrom ? formatDate(v.validFrom) : '—'}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Valid until</dt><dd>{v.validUntil ? formatDate(v.validUntil) : '—'}</dd></div>
                    </dl>
                  )}
                  {at >= 0 && (
                    <ol className="flex flex-wrap gap-x-5 gap-y-2 text-xs" aria-label={`Progress for ${v.travelerName}`}>
                      {STEPS.map((s, i) => (
                        <li key={s} className={`flex items-center gap-1.5 ${i <= at ? 'font-medium' : 'text-muted-foreground'}`} aria-current={i === at ? 'step' : undefined}>
                          {i < at || v.status === 'ISSUED' ? <CheckCircle2 className="size-3.5 text-success" aria-hidden /> : <Circle className={`size-3.5 ${i === at ? 'text-primary' : ''}`} aria-hidden />}
                          {getStatusMeta('visa', s).label}
                        </li>
                      ))}
                    </ol>
                  )}
                  {v.missingDocuments.length > 0 && (v.status === 'DOCUMENTS_PENDING' || v.status === 'UNDER_REVIEW') && (
                    <p className="text-sm">Still needed or being checked: {v.missingDocuments.join(', ')}. <Link className="font-medium underline" href="/account/documents">Go to documents</Link></p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
