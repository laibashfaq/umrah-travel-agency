import Link from 'next/link';
import { Luggage, MailWarning } from 'lucide-react';
import type { BookingSummaryDto, Paginated, TravelerDto } from '@umrah/shared';
import { ResendVerification } from '@/components/auth/auth-forms';
import { StatCard } from '@/components/data/stat-card';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { BookingCard } from '@/components/portal/booking-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth/server';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Dashboard' };

export default async function AccountDashboardPage() {
  const { user } = await requireUser('CUSTOMER');
  // Until the email is verified there is no customer record yet, so there is nothing to load.
  const [bookings, travelers] = user.emailVerified
    ? await Promise.all([portalData<Paginated<BookingSummaryDto>>('/bookings?page=1&pageSize=20'), portalData<TravelerDto[]>('/travelers')])
    : [{ items: [], meta: { total: 0, page: 1, pageSize: 20, pageCount: 1 } } as Paginated<BookingSummaryDto>, [] as TravelerDto[]];
  const unfinished = bookings.items.filter((b) => b.status === 'DRAFT');
  const active = bookings.items.filter((b) => b.status !== 'DRAFT' && b.status !== 'CANCELLED' && b.status !== 'COMPLETED');
  const upcoming = [...active].sort((a, b) => a.departureDate.localeCompare(b.departureDate));

  return (
    <>
      <PageHeader title={`Assalamu alaikum, ${user.firstName}`} description="Your bookings and travelers in one place." actions={<Button asChild variant="gold"><Link href="/packages">Browse packages</Link></Button>} />
      {!user.emailVerified && (
        <Alert className="mb-6 border-warning/40 bg-warning/10">
          <MailWarning className="text-warning" />
          <AlertTitle>Verify your email address</AlertTitle>
          <AlertDescription className="grid gap-3">
            <span>We sent a verification link to <strong>{user.email}</strong>. You need to verify before you can book.</span>
            <ResendVerification email={user.email} />
          </AlertDescription>
        </Alert>
      )}

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <StatCard label="Active bookings" value={String(active.length)} icon={Luggage} />
        <StatCard label="Unfinished bookings" value={String(unfinished.length)} icon={Luggage} hint={unfinished.length ? 'Seats are held for a limited time' : undefined} />
        <StatCard label="Saved travelers" value={String(travelers.length)} icon={Luggage} />
      </div>

      {unfinished.length > 0 && (
        <section aria-labelledby="unfinished" className="mb-8 grid gap-4">
          <h2 id="unfinished" className="font-display text-xl font-semibold">Finish your booking</h2>
          {unfinished.map((b) => <BookingCard key={b.id} booking={b} />)}
        </section>
      )}

      <section aria-labelledby="upcoming" className="grid gap-4">
        <h2 id="upcoming" className="font-display text-xl font-semibold">Your bookings</h2>
        {upcoming.length === 0 ? (
          <EmptyState icon={Luggage} title={bookings.meta.total === 0 ? 'No bookings yet' : 'No active bookings'} description="When you book a package it will appear here with its status and price." action={<Button asChild><Link href="/packages">Browse packages</Link></Button>} />
        ) : (
          upcoming.slice(0, 5).map((b) => <BookingCard key={b.id} booking={b} />)
        )}
        {bookings.meta.total > 0 && <Link href="/account/bookings" className="text-sm font-medium underline">See all bookings</Link>}
      </section>
    </>
  );
}
