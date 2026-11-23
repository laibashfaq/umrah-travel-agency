import Link from 'next/link';
import type { AdminCustomerRowDto, Paginated } from '@umrah/shared';
import { Pager } from '@/components/admin/pager';
import { Forbidden } from '@/components/auth/forbidden';
import { DataTable, type Column } from '@/components/data/data-table';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminData, qs, staffPage } from '@/lib/admin/api';
import { formatDate } from '@/lib/format';

export const metadata = { title: 'Customers' };

export default async function AdminCustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const { allowed } = await staffPage('customers:read');
  if (!allowed) return <Forbidden what="customers" />;
  const sp = await searchParams;
  const result = await adminData<Paginated<AdminCustomerRowDto>>(`/customers${qs({ q: sp.q, page: sp.page, pageSize: 20 })}`);
  const columns: Column<AdminCustomerRowDto>[] = [
    { key: 'name', header: 'Customer', cell: (c) => <Link className="font-medium underline-offset-4 hover:underline" href={`/admin/customers/${c.id}`}>{c.name}</Link> },
    { key: 'contact', header: 'Contact', cell: (c) => <>{c.email ?? '—'}<span className="block text-xs text-muted-foreground">{c.phone ?? ''}</span></> },
    { key: 'city', header: 'City', hideOnMobile: true, cell: (c) => c.city ?? '—' },
    { key: 'account', header: 'Account', hideOnMobile: true, cell: (c) => (c.hasAccount ? <Badge variant="secondary">Has login</Badge> : <Badge variant="outline">No login</Badge>) },
    { key: 'bookings', header: 'Bookings', align: 'end', cell: (c) => c.bookings },
    { key: 'since', header: 'Customer since', hideOnMobile: true, cell: (c) => formatDate(c.createdAt) },
  ];
  return (
    <>
      <PageHeader title="Customers" description="People who have registered or enquired." />
      <form method="get" role="search" aria-label="Search customers" className="mb-6 flex max-w-xl items-end gap-2">
        <label className="grid flex-1 gap-1 text-sm font-medium">Search<Input name="q" defaultValue={sp.q} placeholder="Name, email, phone or city" /></label>
        <Button type="submit">Search</Button>
      </form>
      <DataTable caption="Customers" columns={columns} rows={result.items} rowKey={(c) => c.id} empty={{ title: 'No customers found' }} />
      <Pager basePath="/admin/customers" params={{ q: sp.q }} page={result.meta.page} pageCount={result.meta.pageCount} total={result.meta.total} />
    </>
  );
}
