import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, ExternalLink } from 'lucide-react';
import type { AdminPackageDetailDto } from '@umrah/shared';
import { DeleteDepartureButton, DepartureDialog, PackageForm, PackageStatusPanel } from '@/components/admin/package-forms';
import { Forbidden } from '@/components/auth/forbidden';
import { StatusBadge } from '@/components/data/status-badge';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminData, staffPage } from '@/lib/admin/api';
import { can } from '@/lib/auth/server';
import { formatDateRange, formatMoney, humanize } from '@/lib/format';

export const metadata = { title: 'Package' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminPackagePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string; updated?: string }> }) {
  const { user, allowed } = await staffPage('packages:read');
  if (!allowed) return <Forbidden what="packages" />;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const pkg = await adminData<AdminPackageDetailDto>(`/packages/${id}`);
  const canDepartures = can(user, 'departures:update') && can(user, 'departures:create');

  return (
    <>
      <PageHeader
        title={pkg.title}
        description={pkg.startingPrice ? `From ${formatMoney(pkg.startingPrice, pkg.currency)} per person` : 'No price yet'}
        breadcrumbs={[{ label: 'Packages', href: '/admin/packages' }, { label: pkg.title }]}
        actions={
          <div className="flex items-center gap-3">
            <StatusBadge domain="publish" value={pkg.status} />
            {pkg.status === 'PUBLISHED' && <Link className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline" href={`/packages/${pkg.slug}`} target="_blank" rel="noreferrer">View on site <ExternalLink className="size-3.5" aria-hidden /></Link>}
          </div>
        }
      />
      {(sp.created || sp.updated) && (
        <Alert className="mb-6 border-success/40 bg-success/10" role="status"><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">{sp.created ? 'Package created as a draft. Add a departure with prices, then publish it.' : 'Saved.'}</AlertDescription></Alert>
      )}

      <div className="grid gap-8">
        <Card className="shadow-card">
          <CardHeader><CardTitle className="text-base">Publishing</CardTitle></CardHeader>
          <CardContent><PackageStatusPanel pkg={pkg} canPublish={can(user, 'packages:publish')} /></CardContent>
        </Card>

        <section aria-labelledby="deps" className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="deps" className="font-display text-xl font-semibold">Departures</h2>
            <DepartureDialog packageId={pkg.id} canEdit={canDepartures} />
          </div>
          {pkg.departures.length === 0 ? <p className="text-sm text-muted-foreground">No departures yet. A package needs an upcoming Open departure with a price before it can be published.</p> : (
            <ul className="grid gap-3">
              {pkg.departures.map((d) => (
                <li key={d.id}>
                  <Card className="gap-3 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{formatDateRange(d.departureDate, d.returnDate)}{d.departureCity ? ` · from ${d.departureCity}` : ''}</p>
                        <p className="text-sm text-muted-foreground">{d.seatsReserved} of {d.seatsTotal} seats booked · {d.bookings} active booking{d.bookings === 1 ? '' : 's'}{d.airline ? ` · ${d.airline}` : ''}</p>
                      </div>
                      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">{humanize(d.status)}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {d.prices.length === 0 ? 'No prices set.' : d.prices.map((p) => `${humanize(p.occupancy)} ${formatMoney(p.adultPrice, pkg.currency)}`).join(' · ')}
                    </p>
                    {canDepartures && (
                      <div className="flex flex-wrap items-center gap-2">
                        <DepartureDialog packageId={pkg.id} departure={d} canEdit />
                        <DeleteDepartureButton packageId={pkg.id} departure={d} />
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="details" className="grid gap-4">
          <h2 id="details" className="font-display text-xl font-semibold">Details</h2>
          <PackageForm pkg={pkg} canEdit={can(user, 'packages:update')} />
          <p className="max-w-3xl text-xs text-muted-foreground">Itinerary, hotels, photos and transport for a package are managed with the content tools in a later update.</p>
        </section>
      </div>
    </>
  );
}
