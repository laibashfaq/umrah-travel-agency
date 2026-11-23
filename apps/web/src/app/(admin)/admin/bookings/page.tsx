import Link from 'next/link';
import { BOOKING_STATUS_VALUES, PAYMENT_STATUS_VALUES, type AdminBookingRowDto, type Paginated } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { Forbidden } from '@/components/auth/forbidden';
import { DataTable, type Column } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { NativeSelect } from '@/components/forms/native-select';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminData, qs, staffPage } from '@/lib/admin/api';
import { formatDate, formatMoney, humanize } from '@/lib/format';
import { getStatusMeta } from '@/lib/status';

export const metadata = { title: 'Bookings' };

type Search = { q?: string; status?: string; paymentStatus?: string; assignedToId?: string; departureFrom?: string; departureTo?: string; page?: string };

export default async function AdminBookingsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { allowed } = await staffPage('bookings:read');
  if (!allowed) return <Forbidden what="bookings" />;
  const sp = await searchParams;
  const filters = { q: sp.q, status: sp.status, paymentStatus: sp.paymentStatus, assignedToId: sp.assignedToId, departureFrom: sp.departureFrom, departureTo: sp.departureTo };
  const [result, staff] = await Promise.all([
    adminData<Paginated<AdminBookingRowDto>>(`/bookings${qs({ ...filters, page: sp.page, pageSize: 20 })}`),
    adminData<{ id: string; name: string }[]>('/bookings/assignees'),
  ]);

  const columns: Column<AdminBookingRowDto>[] = [
    { key: 'ref', header: 'Booking', cell: (b) => <Link className="font-medium underline-offset-4 hover:underline" href={`/admin/bookings/${b.id}`}>{b.reference}<span className="block text-xs font-normal text-muted-foreground">{formatDate(b.createdAt)}</span></Link> },
    { key: 'customer', header: 'Customer', cell: (b) => <>{b.customerName}<span className="block text-xs text-muted-foreground">{b.customerEmail}</span></> },
    { key: 'trip', header: 'Trip', hideOnMobile: true, cell: (b) => <>{b.packageTitle}<span className="block text-xs text-muted-foreground">{formatDate(b.departureDate)} · {b.travelers} traveler{b.travelers === 1 ? '' : 's'}</span></> },
    { key: 'status', header: 'Status', cell: (b) => <StatusBadge domain="booking" value={b.status} /> },
    { key: 'payment', header: 'Payment', hideOnMobile: true, cell: (b) => <StatusBadge domain="bookingPayment" value={b.paymentStatus} /> },
    { key: 'total', header: 'Total', align: 'end', cell: (b) => formatMoney(b.grandTotal, b.currency) },
    { key: 'owner', header: 'Handled by', hideOnMobile: true, cell: (b) => b.assignedToName ?? <span className="text-muted-foreground">Unassigned</span> },
  ];

  return (
    <>
      <PageHeader title="Bookings" description="Everything customers have booked. Open a booking to update its status." />
      <form method="get" className="mb-6 grid gap-3 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Filter bookings">
        <label className="grid gap-1 text-sm font-medium lg:col-span-2">Search<Input name="q" defaultValue={sp.q} placeholder="Reference, customer, email, package" /></label>
        <label className="grid gap-1 text-sm font-medium">Status
          <NativeSelect name="status" defaultValue={sp.status ?? ''}><option value="">All</option>{BOOKING_STATUS_VALUES.map((s) => <option key={s} value={s}>{getStatusMeta('booking', s).label}</option>)}</NativeSelect>
        </label>
        <label className="grid gap-1 text-sm font-medium">Payment
          <NativeSelect name="paymentStatus" defaultValue={sp.paymentStatus ?? ''}><option value="">All</option>{PAYMENT_STATUS_VALUES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</NativeSelect>
        </label>
        <label className="grid gap-1 text-sm font-medium">Handled by
          <NativeSelect name="assignedToId" defaultValue={sp.assignedToId ?? ''}><option value="">Anyone</option><option value="none">Unassigned</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</NativeSelect>
        </label>
        <label className="grid gap-1 text-sm font-medium">Departs from<Input name="departureFrom" type="date" defaultValue={sp.departureFrom} /></label>
        <label className="grid gap-1 text-sm font-medium">Departs until<Input name="departureTo" type="date" defaultValue={sp.departureTo} /></label>
        <div className="flex items-end gap-2"><Button type="submit">Apply filters</Button><Button asChild variant="ghost"><Link href="/admin/bookings">Clear</Link></Button></div>
      </form>
      <DataTable caption="Bookings" columns={columns} rows={result.items} rowKey={(b) => b.id} empty={{ title: 'No bookings match', description: 'Try clearing a filter.' }} />
      <Pager basePath="/admin/bookings" params={filters} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
