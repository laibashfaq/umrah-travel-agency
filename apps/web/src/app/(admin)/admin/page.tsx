import Link from 'next/link';
import { CalendarClock, ClipboardList, Package, ShieldCheck, Users, Wallet } from 'lucide-react';
import type { DashboardStatsDto } from '@umrah/shared';
import { Forbidden } from '@/components/auth/forbidden';
import { StatCard } from '@/components/data/stat-card';
import { StatusBadge } from '@/components/data/status-badge';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminData, staffPage } from '@/lib/admin/api';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/lib/format';

export const metadata = { title: 'Dashboard' };

const STATUS_ORDER = ['PENDING_PAYMENT', 'CONFIRMED', 'VISA_PROCESSING', 'TRAVEL_PREPARATION', 'COMPLETED', 'CANCELLED', 'DRAFT'] as const;

export default async function AdminDashboardPage() {
  const { user, allowed } = await staffPage('dashboard:read');
  if (!allowed) return <Forbidden what="the dashboard" />;
  const s = await adminData<DashboardStatsDto>('/dashboard');
  const canBookings = user.permissions.includes('bookings:read');

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.firstName}`}
        description={`Figures as of ${formatDateTime(s.generatedAt)}.`}
        actions={<Button asChild variant="outline"><Link href="/admin/security"><ShieldCheck /> Security</Link></Button>}
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Awaiting payment" value={formatNumber(s.bookings.awaitingAction)} icon={ClipboardList} hint="Submitted bookings to follow up" />
        <StatCard label="New bookings (7 days)" value={formatNumber(s.bookings.createdLast7Days)} icon={CalendarClock} />
        <StatCard label="Booked value" value={formatMoney(s.revenue.bookedValue, s.revenue.currency)} icon={Wallet} hint="Submitted, not cancelled" />
        <StatCard label="Customers" value={formatNumber(s.customers.total)} icon={Users} hint={`${s.customers.newLast30Days} new in 30 days`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="min-w-0 shadow-card">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Recent bookings</CardTitle>
            {canBookings && <Button asChild variant="ghost" size="sm"><Link href="/admin/bookings">View all</Link></Button>}
          </CardHeader>
          <CardContent>
            {s.recentBookings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bookings have been submitted yet.</p>
            ) : (
              <ul className="divide-y">
                {s.recentBookings.map((b) => (
                  <li key={b.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <div className="min-w-0 max-w-full">
                      {canBookings ? <Link className="font-medium underline-offset-4 hover:underline" href={`/admin/bookings/${b.id}`}>{b.reference}</Link> : <span className="font-medium">{b.reference}</span>}
                      <p className="truncate text-muted-foreground">{b.packageTitle} · departs {formatDate(b.departureDate)}</p>
                    </div>
                    <div className="flex items-center gap-3"><span className="tabular-nums">{formatMoney(b.grandTotal, b.currency)}</span><StatusBadge domain="booking" value={b.status} /></div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="grid min-w-0 content-start gap-6">
          <Card className="shadow-card">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Package className="size-4" aria-hidden /> Catalogue</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid gap-2 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">Published packages</dt><dd className="tabular-nums">{s.catalog.publishedPackages}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Open departures</dt><dd className="tabular-nums">{s.catalog.openDepartures}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Seats left</dt><dd className="tabular-nums">{s.catalog.seatsLeft}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Leaving in 30 days</dt><dd className="tabular-nums">{s.catalog.departuresLeavingIn30Days}</dd></div>
              </dl>
            </CardContent>
          </Card>
          <Card className="shadow-card">
            <CardHeader><CardTitle className="text-base">Bookings by status</CardTitle></CardHeader>
            <CardContent>
              <ul className="grid gap-2 text-sm">
                {STATUS_ORDER.filter((k) => s.bookings.byStatus[k]).map((k) => (
                  <li key={k} className="flex items-center justify-between"><StatusBadge domain="booking" value={k} /><span className="tabular-nums">{s.bookings.byStatus[k]}</span></li>
                ))}
                {Object.keys(s.bookings.byStatus).length === 0 && <li className="text-muted-foreground">Nothing yet.</li>}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
      <p className="mt-6 text-xs text-muted-foreground">{s.revenue.note}</p>
    </>
  );
}
