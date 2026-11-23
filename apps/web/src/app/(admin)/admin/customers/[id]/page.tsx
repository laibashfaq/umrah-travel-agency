import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { AdminCustomerDetailDto } from '@umrah/shared';
import { NoteForm } from '@/components/admin/booking-panels';
import { Forbidden } from '@/components/auth/forbidden';
import { StatusBadge } from '@/components/data/status-badge';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminData, staffPage } from '@/lib/admin/api';
import { can } from '@/lib/auth/server';
import { countryName } from '@/lib/countries';
import { formatDate, formatDateRange, formatDateTime, formatMoney, humanize } from '@/lib/format';

export const metadata = { title: 'Customer' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, allowed } = await staffPage('customers:read');
  if (!allowed) return <Forbidden what="customers" />;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const c = await adminData<AdminCustomerDetailDto>(`/customers/${id}`);
  const canBookings = can(user, 'bookings:read');
  return (
    <>
      <PageHeader title={`${c.firstName} ${c.lastName}`} description={`Customer since ${formatDate(c.createdAt)} · ${c.hasAccount ? 'has an online account' : 'no online account'}`} breadcrumbs={[{ label: 'Customers', href: '/admin/customers' }, { label: `${c.firstName} ${c.lastName}` }]} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-card">
          <CardHeader><CardTitle className="text-base">Contact</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm">
              <div><dt className="text-xs text-muted-foreground">Email</dt><dd>{c.email ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Phone</dt><dd>{c.phone ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">WhatsApp</dt><dd>{c.whatsappNumber ?? '—'}{c.whatsappOptIn ? ' (agreed to messages)' : ''}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Location</dt><dd>{[c.addressLine, c.city, countryName(c.country)].filter(Boolean).join(', ') || '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Language · marketing</dt><dd>{c.preferredLanguage.toUpperCase()} · {c.marketingOptIn ? 'agreed to offers' : 'no offers'}</dd></div>
            </dl>
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader><CardTitle className="text-base">Bookings</CardTitle></CardHeader>
          <CardContent>
            {c.bookings.length === 0 ? <p className="text-sm text-muted-foreground">No bookings yet.</p> : (
              <ul className="divide-y">
                {c.bookings.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <div>
                      {canBookings ? <Link className="font-medium underline-offset-4 hover:underline" href={`/admin/bookings/${b.id}`}>{b.reference}</Link> : <span className="font-medium">{b.reference}</span>}
                      <p className="text-muted-foreground">{b.packageTitle} · {formatDateRange(b.departureDate, b.returnDate)}</p>
                    </div>
                    <div className="flex items-center gap-2"><span className="tabular-nums">{formatMoney(b.grandTotal, b.currency)}</span><StatusBadge domain="booking" value={b.status} /></div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader><CardTitle className="text-base">Saved travelers</CardTitle></CardHeader>
          <CardContent>
            {c.travelers.length === 0 ? <p className="text-sm text-muted-foreground">None saved.</p> : (
              <ul className="divide-y">
                {c.travelers.map((t) => (
                  <li key={t.id} className="py-3 text-sm">
                    <p className="font-medium">{[t.firstName, t.middleName, t.lastName].filter(Boolean).join(' ')}</p>
                    <p className="text-muted-foreground">{humanize(t.relationship)} · born {formatDate(t.dateOfBirth)} · passport <span className="font-mono">{t.passportNumberMasked ?? 'none'}</span>{t.passportExpiryDate ? ` (expires ${formatDate(t.passportExpiryDate)})` : ''}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
          <CardContent className="grid gap-5">
            {c.notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
              <ul className="grid gap-3">
                {c.notes.map((n) => <li key={n.id} className="rounded-lg bg-muted/50 p-3 text-sm"><p>{n.body}</p><p className="mt-1 text-xs text-muted-foreground">{n.authorName ?? 'Staff'} · {formatDateTime(n.createdAt)}</p></li>)}
              </ul>
            )}
            {can(user, 'customers:update') && <NoteForm target="customer" id={c.id} />}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
