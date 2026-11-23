import Link from 'next/link';
import { Luggage } from 'lucide-react';
import type { BookingSummaryDto, Paginated } from '@umrah/shared';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { BookingCard } from '@/components/portal/booking-card';
import { Button } from '@/components/ui/button';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'My bookings' };

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Math.max(1, Math.min(1000, Number((await searchParams).page) || 1));
  const { items, meta } = await portalData<Paginated<BookingSummaryDto>>(`/bookings?page=${page}&pageSize=10`);
  return (
    <>
      <PageHeader title="My bookings" description="Your Umrah bookings, payments and progress." actions={<Button asChild variant="gold"><Link href="/packages">Browse packages</Link></Button>} />
      {items.length === 0 ? (
        <EmptyState icon={Luggage} title="No bookings yet" description="When you book a package it will appear here." action={<Button asChild><Link href="/packages">Browse packages</Link></Button>} />
      ) : (
        <div className="grid gap-4">
          {items.map((b) => <BookingCard key={b.id} booking={b} />)}
          {meta.pageCount > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between pt-2 text-sm">
              {page > 1 ? <Link className="font-medium underline" href={`/account/bookings?page=${page - 1}`}>Previous</Link> : <span />}
              <span className="text-muted-foreground">Page {page} of {meta.pageCount}</span>
              {page < meta.pageCount ? <Link className="font-medium underline" href={`/account/bookings?page=${page + 1}`}>Next</Link> : <span />}
            </nav>
          )}
        </div>
      )}
    </>
  );
}
