import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import { BOOKING_STATUSES, type BookingDetailDto, type BookingMoneyDto, type InvoiceDto, type PaymentDto, type TravelerDto } from '@umrah/shared';
import { PriceSummary } from '@/components/commerce/price-summary';
import { StepIndicator } from '@/components/commerce/step-indicator';
import { StatusBadge } from '@/components/data/status-badge';
import { PageHeader } from '@/components/layout/page-header';
import { CancelBooking, SubmitBooking } from '@/components/portal/booking-actions';
import { ReportPaymentForm } from '@/components/portal/payment-panel';
import { TravelerAssignment } from '@/components/portal/traveler-assignment';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { StatusBadge as Badge } from '@/components/data/status-badge';
import { formatDate, formatDateRange, formatDateTime, formatMoney, humanize } from '@/lib/format';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Booking' };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ submitted?: string; saved?: string; paymentReported?: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BookingPage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { submitted, saved, paymentReported } = await searchParams;
  const booking = await portalData<BookingDetailDto>(`/bookings/${id}`);
  const isDraft = booking.status === 'DRAFT';
  const travelers = isDraft ? await portalData<TravelerDto[]>('/travelers') : [];
  const hasTravelers = booking.travelerList.length > 0;
  const showMoney = booking.status !== 'DRAFT';
  const [money, allPayments, allInvoices] = showMoney
    ? await Promise.all([portalData<BookingMoneyDto>(`/bookings/${id}/money`), portalData<PaymentDto[]>('/payments'), portalData<InvoiceDto[]>('/invoices')])
    : [null, [] as PaymentDto[], [] as InvoiceDto[]];
  const payments = allPayments.filter((p) => p.bookingId === id);
  const invoice = allInvoices.find((i) => i.bookingId === id && i.status !== 'VOID');
  const canPay = money !== null && Number(money.payable) > 0 && booking.status !== 'CANCELLED' && booking.status !== 'COMPLETED';
  const balance = Math.max(0, Number(booking.grandTotal) - Number(booking.depositAmount)).toFixed(2);

  return (
    <>
      <PageHeader
        title={booking.packageTitle}
        description={`${booking.reference} · ${formatDateRange(booking.departureDate, booking.returnDate)}${booking.departureCity ? ` · from ${booking.departureCity}` : ''}`}
        breadcrumbs={[{ label: 'My bookings', href: '/account/bookings' }, { label: booking.reference }]}
        actions={<StatusBadge domain="booking" value={booking.status} />}
      />

      {submitted && (
        <Alert className="mb-6 border-success/40 bg-success/10" role="status">
          <CheckCircle2 className="text-success" />
          <AlertTitle>Booking submitted</AlertTitle>
          <AlertDescription>Thank you. Our team has your booking and will contact you with payment instructions. We also emailed you a copy.</AlertDescription>
        </Alert>
      )}
      {paymentReported && (
        <Alert className="mb-6 border-success/40 bg-success/10" role="status">
          <CheckCircle2 className="text-success" />
          <AlertTitle>Thank you, we have your payment details</AlertTitle>
          <AlertDescription>Our finance team will check it against the bank and confirm. Its status is shown below.</AlertDescription>
        </Alert>
      )}
      {saved && isDraft && (
        <Alert className="mb-6 border-success/40 bg-success/10" role="status">
          <CheckCircle2 className="text-success" />
          <AlertDescription>Travelers saved.</AlertDescription>
        </Alert>
      )}

      {isDraft && (
        <div className="mb-8 grid gap-3">
          <StepIndicator current={hasTravelers ? 'PAYMENT' : 'TRAVELER_DETAILS'} />
          {booking.seatHoldExpiresAt && (
            <p className="text-sm text-warning">Your seats are held until {formatDateTime(booking.seatHoldExpiresAt)}. After that the booking is cancelled automatically.</p>
          )}
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="grid content-start gap-8">
          {isDraft ? (
            <>
              <section aria-labelledby="who" className="grid gap-4">
                <h2 id="who" className="font-display text-xl font-semibold">Who is travelling?</h2>
                <TravelerAssignment booking={booking} travelers={travelers} />
              </section>
              <section aria-labelledby="submit" className="grid gap-4">
                <h2 id="submit" className="font-display text-xl font-semibold">Review and submit</h2>
                {booking.blockers.length > 0 && (
                  <Alert className="border-warning/40 bg-warning/10">
                    <AlertTriangle className="text-warning" />
                    <AlertTitle>Still to do</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc ps-5">{booking.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                      {hasTravelers && <p className="mt-2">Fix passport details under <a className="font-medium underline" href="/account/travelers">Travelers</a>, then come back.</p>}
                    </AlertDescription>
                  </Alert>
                )}
                <SubmitBooking bookingId={booking.id} ready={booking.blockers.length === 0} />
              </section>
            </>
          ) : (
            <>
              <Progress booking={booking} />
              <section aria-labelledby="travelers" className="grid gap-3">
                <h2 id="travelers" className="font-display text-xl font-semibold">Travelers</h2>
                <ul className="divide-y rounded-xl border">
                  {booking.travelerList.map((t) => (
                    <li key={t.travelerId} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
                      <span className="font-medium">{t.name}{t.isLead && <span className="ms-2 text-xs font-normal text-muted-foreground">Lead traveler</span>}</span>
                      <span className="text-muted-foreground">{humanize(t.kind)}{t.roomIndex !== null ? ` · Room ${t.roomIndex + 1}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </section>
              {booking.specialRequests && (
                <section aria-labelledby="req" className="grid gap-2">
                  <h2 id="req" className="font-display text-xl font-semibold">Special requests</h2>
                  <p className="text-sm text-muted-foreground">{booking.specialRequests}</p>
                </section>
              )}
              {booking.status === 'CANCELLED' && (
                <Alert variant="destructive">
                  <AlertTitle>Cancelled {booking.cancelledAt ? formatDate(booking.cancelledAt) : ''}</AlertTitle>
                  {booking.cancellationReason && <AlertDescription>{booking.cancellationReason}</AlertDescription>}
                </Alert>
              )}
              {money && (
                <section aria-labelledby="payments" className="grid gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 id="payments" className="font-display text-xl font-semibold">Payments</h2>
                    {invoice && <Link className="text-sm font-medium underline-offset-4 hover:underline" href={`/account/invoices/${invoice.id}`}>View invoice {invoice.number}</Link>}
                  </div>
                  <dl className="grid grid-cols-2 gap-3 rounded-xl border p-4 text-sm sm:grid-cols-4">
                    <div><dt className="text-xs text-muted-foreground">Total</dt><dd className="font-medium tabular-nums">{formatMoney(money.grandTotal, money.currency)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Deposit</dt><dd className="font-medium tabular-nums">{formatMoney(money.depositAmount, money.currency)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Paid so far</dt><dd className="font-medium tabular-nums">{formatMoney(money.net, money.currency)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Still to pay</dt><dd className="font-medium tabular-nums">{formatMoney(money.balanceDue, money.currency)}</dd></div>
                  </dl>
                  {booking.status === 'PENDING_PAYMENT' && (
                    <Card className="gap-2 p-5 text-sm">
                      <h3 className="font-display text-lg font-semibold">How to pay</h3>
                      {money.instructions ? <p className="whitespace-pre-line text-muted-foreground">{money.instructions}</p> : <p className="text-muted-foreground">Our team will send you our bank details and payment instructions. Please call or message us if you have not heard from us within one working day. Once you have paid, tell us below.</p>}
                    </Card>
                  )}
                  {payments.length > 0 && (
                    <ul className="divide-y rounded-xl border">
                      {payments.map((p) => (
                        <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
                          <div><p className="font-medium">{p.reference} · {formatMoney(p.amount, p.currency)}</p><p className="text-muted-foreground">{humanize(p.method)}{p.paidOn ? `, ${formatDate(p.paidOn)}` : ''}{p.transactionRef ? `, ref ${p.transactionRef}` : ''}</p>{p.status === 'FAILED' && p.failureMessage && <p className="text-destructive">{p.failureMessage}</p>}</div>
                          <Badge domain="payment" value={p.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {canPay && (
                    <Card className="gap-4 p-5">
                      <h3 className="font-display text-lg font-semibold">Made a payment?</h3>
                      <ReportPaymentForm bookingId={booking.id} payable={formatMoney(money.payable, money.currency)} suggested={Number(money.net) < Number(money.depositAmount) ? String(Math.min(Number(money.payable), Number(money.depositAmount) - Number(money.net))) : money.payable} />
                    </Card>
                  )}
                </section>
              )}
              <section aria-labelledby="history" className="grid gap-3">
                <h2 id="history" className="font-display text-xl font-semibold">History</h2>
                <ol className="grid gap-2 text-sm">
                  {[...booking.history].reverse().map((h, i) => (
                    <li key={i} className="flex flex-wrap gap-x-3">
                      <span className="font-medium">{humanize(h.status)}</span>
                      <span className="text-muted-foreground">{formatDateTime(h.at)}{h.note ? ` · ${h.note}` : ''}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
          {booking.canCancel && <div><CancelBooking bookingId={booking.id} reference={booking.reference} /></div>}
        </div>

        <aside aria-label="Price" className="lg:sticky lg:top-24 lg:self-start">
          <PriceSummary
            title="Price"
            currency={booking.currency}
            lines={booking.rooms.map((r) => ({ label: `Room ${r.index + 1} · ${humanize(r.occupancy)} (${r.adults}A${r.children ? ` ${r.children}C` : ''}${r.infants ? ` ${r.infants}I` : ''})`, amount: r.lineTotal }))}
            total={booking.grandTotal}
            dueNow={booking.status === 'CANCELLED' ? undefined : booking.depositAmount}
            balance={booking.status === 'CANCELLED' ? undefined : balance}
            balanceDueDate={booking.balanceDueDate ?? undefined}
          />
        </aside>
      </div>
    </>
  );
}

/** Where the booking is on its way to departure. */
function Progress({ booking }: { booking: BookingDetailDto }) {
  if (booking.status === 'CANCELLED') return null;
  const steps = BOOKING_STATUSES.filter((s) => s !== 'DRAFT' && s !== 'CANCELLED');
  const current = steps.indexOf(booking.status as (typeof steps)[number]);
  return (
    <ol className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border p-4 text-sm" aria-label="Booking progress">
      {steps.map((s, i) => (
        <li key={s} className={`flex items-center gap-2 ${i <= current ? 'font-medium' : 'text-muted-foreground'}`} aria-current={i === current ? 'step' : undefined}>
          {i < current ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <Circle className={`size-4 ${i === current ? 'text-primary' : ''}`} aria-hidden />}
          {humanize(s)}
        </li>
      ))}
    </ol>
  );
}
