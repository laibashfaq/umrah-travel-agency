import Link from 'next/link';
import { Pencil, UserPlus, UsersRound } from 'lucide-react';
import type { TravelerDto } from '@umrah/shared';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { countryName } from '@/lib/countries';
import { formatDate, humanize } from '@/lib/format';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Travelers' };

export default async function TravelersPage() {
  const travelers = await portalData<TravelerDto[]>('/travelers');
  const add = <Button asChild variant="gold"><Link href="/account/travelers/new"><UserPlus /> Add traveler</Link></Button>;
  return (
    <>
      <PageHeader title="Travelers" description="People you book for. Save their details once and reuse them on every booking." actions={add} />
      {travelers.length === 0 ? (
        <EmptyState icon={UsersRound} title="No travelers saved" description="Add yourself and anyone travelling with you, with passport details exactly as printed." action={add} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {travelers.map((t) => (
            <li key={t.id}>
              <Card className="h-full gap-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-display text-lg font-semibold">{[t.title, t.firstName, t.middleName, t.lastName].filter(Boolean).join(' ')}</h2>
                    <p className="text-sm text-muted-foreground">{humanize(t.relationship)} · {t.gender === 'MALE' ? 'Male' : 'Female'} · born {formatDate(t.dateOfBirth)}</p>
                  </div>
                  <Button asChild variant="outline" size="sm"><Link href={`/account/travelers/${t.id}`}><Pencil /> Edit<span className="sr-only"> {t.firstName} {t.lastName}</span></Link></Button>
                </div>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div><dt className="text-xs text-muted-foreground">Nationality</dt><dd>{countryName(t.nationality)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Passport</dt><dd className="font-mono">{t.passportNumberMasked ?? '—'}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Passport expires</dt><dd>{t.passportExpiryDate ? formatDate(t.passportExpiryDate) : '—'}</dd></div>
                </dl>
                {!t.passportNumberMasked && <Badge variant="outline" className="w-fit border-warning/50 text-warning">Passport details needed before booking</Badge>}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
