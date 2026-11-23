import Link from 'next/link';
import { ArrowRight, CalendarDays, Users } from 'lucide-react';
import type { BookingSummaryDto } from '@umrah/shared';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatDateRange, formatDateTime, formatMoney, pluralize } from '@/lib/format';

export function BookingCard({ booking: b }: { booking: BookingSummaryDto }) {
  const isDraft = b.status === 'DRAFT';
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">{b.reference}</p>
          <h3 className="font-display text-lg font-semibold leading-snug">{b.packageTitle}</h3>
        </div>
        <StatusBadge domain="booking" value={b.status} />
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-2"><CalendarDays className="size-4" aria-hidden /><dt className="sr-only">Travel dates</dt><dd>{formatDateRange(b.departureDate, b.returnDate)}</dd></div>
        <div className="flex items-center gap-2"><Users className="size-4" aria-hidden /><dt className="sr-only">Travelers</dt><dd>{pluralize(b.travelers, 'traveler')}</dd></div>
      </dl>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="font-display text-xl font-semibold tabular-nums">{formatMoney(b.grandTotal, b.currency)}</p>
          {isDraft && b.seatHoldExpiresAt && <p className="text-xs text-warning">Seats held until {formatDateTime(b.seatHoldExpiresAt)}</p>}
        </div>
        <Button asChild variant={isDraft ? 'gold' : 'outline'}>
          <Link href={`/account/bookings/${b.id}`}>{isDraft ? 'Continue booking' : 'View booking'} <ArrowRight className="rtl:rotate-180" /></Link>
        </Button>
      </div>
    </Card>
  );
}
