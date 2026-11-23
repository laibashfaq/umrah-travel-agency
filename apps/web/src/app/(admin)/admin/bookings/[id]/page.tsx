import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import type { AdminBookingDetailDto, BookingMoneyDto, InvoiceDto, PaymentDto, RefundDto, VisaDto } from '@umrah/shared';
import { AssignPanel, NoteForm, StatusPanel } from '@/components/admin/booking-panels';
import { StartVisasButton } from '@/components/admin/visa-panels';
import { IssueInvoiceButton, RecordPaymentForm, RefundRequestDialog } from '@/components/admin/finance-panels';
import { StatusBadge as Badge } from '@/components/data/status-badge';
import { Forbidden } from '@/components/auth/forbidden';
import { PriceSummary } from '@/components/commerce/price-summary';
import { StatusBadge } from '@/components/data/status-badge';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminData, staffPage } from '@/lib/admin/api';
import { can } from '@/lib/auth/server';
import { countryName } from '@/lib/countries';
import { formatDate, formatDateRange, formatDateTime, formatMoney, humanize } from '@/lib/format';

export const metadata = { title: 'Booking' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminBookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ updated?: string }> }) {
  const { user, allowed } = await staffPage('bookings:read');
  if (!allowed) return <Forbidden what="bookings" />;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { updated } = await searchParams;
  const [b, staff] = await Promise.all([adminData<AdminBookingDetailDto>(`/bookings/${id}`), adminData<{ id: string; name: string }[]>('/bookings/assignees')]);
  const canFinance = can(user, 'payments:read');
  const finance = canFinance
    ? await adminData<{ money: BookingMoneyDto; payments: PaymentDto[]; refunds: RefundDto[]; invoices: InvoiceDto[] }>(`/bookings/${id}/finance`)
    : null;
  const visas = can(user, 'visas:read') ? await adminData<VisaDto[]>(`/bookings/${id}/visas`) : null;
  const visaReady = b.status === 'CONFIRMED' || b.status === 'VISA_PROCESSING' || b.status === 'TRAVEL_PREPARATION';
  const liveInvoice = finance?.invoices.find((i) => i.status !== 'VOID');
  const balance = Math.max(0, Number(b.grandTotal) - Number(b.depositAmount)).toFixed(2);

  return (
    <>
      <PageHeader
        title={b.reference}
        description={`${b.packageTitle} · ${formatDateRange(b.departureDate, b.returnDate)}${b.departureCity ? ` · from ${b.departureCity}` : ''}`}
        breadcrumbs={[{ label: 'Bookings', href: '/admin/bookings' }, { label: b.reference }]}
        actions={<div className="flex items-center gap-2"><StatusBadge domain="booking" value={b.status} /><StatusBadge domain="bookingPayment" value={b.paymentStatus} /></div>}
      />
      {updated && (
        <Alert className="mb-6 border-success/40 bg-success/10" role="status"><CheckCircle2 className="text-success" /><AlertDescription className="text-foreground">Booking updated.</AlertDescription></Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">Customer</CardTitle></CardHeader>
            <CardContent className="grid gap-1 text-sm">
              {can(user, 'customers:read') ? <Link className="w-fit font-medium underline-offset-4 hover:underline" href={`/admin/customers/${b.customer.id}`}>{b.customer.name}</Link> : <span className="font-medium">{b.customer.name}</span>}
              <p className="text-muted-foreground">{b.customer.email ?? 'No email'} · {b.customer.phone ?? 'No phone'}{b.customer.whatsappNumber ? ` · WhatsApp ${b.customer.whatsappNumber}` : ''}</p>
              <p className="text-muted-foreground">Booked online ({humanize(b.source)}) on {formatDate(b.createdAt)}{b.submittedAt ? `, submitted ${formatDateTime(b.submittedAt)}` : ''}</p>
            </CardContent>
          </Card>

          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">Travelers</CardTitle></CardHeader>
            <CardContent>
              {b.staffTravelers.length === 0 ? <p className="text-sm text-muted-foreground">No travelers chosen yet.</p> : (
                <ul className="divide-y">
                  {b.staffTravelers.map((t) => (
                    <li key={t.id} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]">
                      <div>
                        <p className="font-medium">{[t.title, t.firstName, t.middleName, t.lastName].filter(Boolean).join(' ')}{t.isLead && <span className="ms-2 text-xs font-normal text-muted-foreground">Lead traveler</span>}</p>
                        <p className="text-muted-foreground">{humanize(t.kind)} · {t.gender === 'MALE' ? 'Male' : 'Female'} · born {formatDate(t.dateOfBirth)} · {countryName(t.nationality)}</p>
                        {t.specialRequirements && <p className="text-muted-foreground">Needs: {t.specialRequirements}</p>}
                      </div>
                      <div className="text-muted-foreground sm:text-end">
                        <p>Passport <span className="font-mono">{t.passportNumberMasked ?? 'missing'}</span>{t.passportExpiryDate ? `, expires ${formatDate(t.passportExpiryDate)}` : ''}</p>
                        {t.roomIndex !== null && <p>Room {t.roomIndex + 1}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {b.specialRequests && <p className="mt-3 border-t pt-3 text-sm"><span className="text-muted-foreground">Customer request: </span>{b.specialRequests}</p>}
            </CardContent>
          </Card>

          {finance && (
            <Card className="shadow-card">
              <CardHeader><CardTitle className="text-base">Money</CardTitle></CardHeader>
              <CardContent className="grid gap-5">
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div><dt className="text-xs text-muted-foreground">Total</dt><dd className="font-medium tabular-nums">{formatMoney(finance.money.grandTotal, finance.money.currency)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Received</dt><dd className="font-medium tabular-nums">{formatMoney(finance.money.amountPaid, finance.money.currency)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Refunded</dt><dd className="font-medium tabular-nums">{formatMoney(finance.money.amountRefunded, finance.money.currency)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Balance due</dt><dd className="font-medium tabular-nums">{formatMoney(finance.money.balanceDue, finance.money.currency)}</dd></div>
                </dl>
                {finance.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments yet.</p> : (
                  <ul className="divide-y rounded-lg border">
                    {finance.payments.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                        <div><p className="font-medium">{p.reference} · {formatMoney(p.amount, p.currency)}</p><p className="text-muted-foreground">{humanize(p.method)}{p.paidOn ? `, ${formatDate(p.paidOn)}` : ''}{p.transactionRef ? `, ref ${p.transactionRef}` : ''}{p.verifiedByName ? ` · checked by ${p.verifiedByName}` : ''}</p></div>
                        <div className="flex items-center gap-2"><Badge domain="payment" value={p.status} />{can(user, 'refunds:create') && (p.status === 'SUCCESSFUL' || p.status === 'PARTIALLY_REFUNDED') && <RefundRequestDialog paymentId={p.id} reference={p.reference} max={String(Number(p.amount) - Number(p.refundedAmount))} />}</div>
                      </li>
                    ))}
                  </ul>
                )}
                {finance.refunds.length > 0 && (
                  <ul className="grid gap-1 text-sm">
                    {finance.refunds.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2"><Badge domain="refund" value={r.status} /><span>{formatMoney(r.amount, r.currency)} · {r.reason}</span></li>)}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  {liveInvoice ? <Link className="font-medium underline-offset-4 hover:underline" href={`/admin/invoices/${liveInvoice.id}`}>Invoice {liveInvoice.number}</Link> : can(user, 'invoices:create') && b.status !== 'DRAFT' && b.status !== 'CANCELLED' ? <IssueInvoiceButton bookingId={b.id} /> : <span className="text-muted-foreground">No invoice</span>}
                </div>
                {can(user, 'payments:create') && b.status !== 'DRAFT' && b.status !== 'CANCELLED' && b.status !== 'COMPLETED' && Number(finance.money.payable) > 0 && (
                  <div className="border-t pt-5">
                    <h3 className="mb-3 font-display text-base font-semibold">Record a payment</h3>
                    <RecordPaymentForm bookingId={b.id} payable={formatMoney(finance.money.payable, finance.money.currency)} countsAtOnce={can(user, 'payments:verify')} />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {visas && (
            <Card className="shadow-card">
              <CardHeader><CardTitle className="text-base">Visas</CardTitle></CardHeader>
              <CardContent className="grid gap-4">
                {visas.length === 0 ? <p className="text-sm text-muted-foreground">{visaReady ? 'No visa applications have been opened yet.' : 'Visa applications start once the booking is confirmed.'}</p> : (
                  <ul className="divide-y rounded-lg border">
                    {visas.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                        <div><Link className="font-medium underline-offset-4 hover:underline" href={`/admin/visas/${v.id}`}>{v.travelerName}</Link>{v.missingDocuments.length > 0 && <p className="text-muted-foreground">Waiting for: {v.missingDocuments.join(', ')}</p>}</div>
                        <Badge domain="visa" value={v.status} />
                      </li>
                    ))}
                  </ul>
                )}
                {can(user, 'visas:create') && visaReady && visas.length < b.staffTravelers.length && <StartVisasButton bookingId={b.id} />}
              </CardContent>
            </Card>
          )}

          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">Internal notes</CardTitle></CardHeader>
            <CardContent className="grid gap-5">
              {b.notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
                <ul className="grid gap-3">
                  {b.notes.map((n) => (
                    <li key={n.id} className="rounded-lg bg-muted/50 p-3 text-sm"><p>{n.body}</p><p className="mt-1 text-xs text-muted-foreground">{n.authorName ?? 'Staff'} · {formatDateTime(n.createdAt)}</p></li>
                  ))}
                </ul>
              )}
              {can(user, 'bookings:update') && <NoteForm target="booking" id={b.id} />}
            </CardContent>
          </Card>

          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
            <CardContent>
              <ol className="grid gap-2 text-sm">
                {[...b.history].reverse().map((h, i) => (
                  <li key={i} className="flex flex-wrap gap-x-3"><span className="font-medium">{humanize(h.status)}</span><span className="text-muted-foreground">{formatDateTime(h.at)}{h.note ? ` · ${h.note}` : ''}</span></li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <aside className="grid content-start gap-6" aria-label="Actions and price">
          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">Status</CardTitle></CardHeader>
            <CardContent><StatusPanel key={b.status} bookingId={b.id} allowed={b.allowedTransitions} canUpdate={can(user, 'bookings:update')} canCancel={can(user, 'bookings:cancel')} /></CardContent>
          </Card>
          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">Assignment</CardTitle></CardHeader>
            <CardContent><AssignPanel bookingId={b.id} assignedToId={b.assignedToId} staff={staff} canAssign={can(user, 'bookings:assign')} /></CardContent>
          </Card>
          <PriceSummary
            title="Price"
            currency={b.currency}
            lines={b.rooms.map((r) => ({ label: `Room ${r.index + 1} · ${humanize(r.occupancy)} (${r.adults}A${r.children ? ` ${r.children}C` : ''}${r.infants ? ` ${r.infants}I` : ''})`, amount: r.lineTotal }))}
            total={b.grandTotal}
            dueNow={b.status === 'CANCELLED' ? undefined : b.depositAmount}
            balance={b.status === 'CANCELLED' ? undefined : balance}
            balanceDueDate={b.balanceDueDate ?? undefined}
          />
        </aside>
      </div>
    </>
  );
}
