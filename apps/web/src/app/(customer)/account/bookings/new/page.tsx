import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CalendarX2 } from 'lucide-react';
import type { DepartureOptionsDto } from '@umrah/shared';
import { StepIndicator } from '@/components/commerce/step-indicator';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { RoomPlanner } from '@/components/portal/room-planner';
import { Button } from '@/components/ui/button';
import { formatDateRange } from '@/lib/format';
import { portal } from '@/lib/portal/api';

export const metadata = { title: 'Choose rooms' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewBookingPage({ searchParams }: { searchParams: Promise<{ departure?: string }> }) {
  const { departure } = await searchParams;
  if (!departure || !UUID.test(departure)) redirect('/packages');
  const res = await portal<DepartureOptionsDto>(`/departures/${departure}`);
  if (!res.ok && res.status === 401) redirect('/login');
  if (!res.ok || !res.data.bookable) {
    return (
      <EmptyState
        icon={CalendarX2}
        title="This departure is not available"
        description="It may be full, closed for booking, or no longer offered. Please choose another date."
        action={<Button asChild><Link href="/packages">Browse packages</Link></Button>}
      />
    );
  }
  const o = res.data;
  return (
    <>
      <PageHeader
        title="Choose your rooms"
        description={`${o.packageTitle} · ${formatDateRange(o.departureDate, o.returnDate)}${o.departureCity ? ` · from ${o.departureCity}` : ''}`}
        breadcrumbs={[{ label: 'Packages', href: '/packages' }, { label: o.packageTitle, href: `/packages/${o.packageSlug}` }, { label: 'Book' }]}
      />
      <StepIndicator current="ROOMS" className="mb-8" />
      <RoomPlanner options={o} />
    </>
  );
}
