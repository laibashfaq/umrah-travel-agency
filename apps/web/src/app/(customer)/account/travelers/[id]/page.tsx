import { notFound } from 'next/navigation';
import type { TravelerDto } from '@umrah/shared';
import { PageHeader } from '@/components/layout/page-header';
import { DeleteTravelerButton, TravelerForm } from '@/components/portal/traveler-form';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Edit traveler' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditTravelerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [traveler, all] = await Promise.all([portalData<TravelerDto>(`/travelers/${id}`), portalData<TravelerDto[]>('/travelers')]);
  return (
    <>
      <PageHeader
        title={`${traveler.firstName} ${traveler.lastName}`}
        breadcrumbs={[{ label: 'Travelers', href: '/account/travelers' }, { label: 'Edit' }]}
        actions={<DeleteTravelerButton traveler={traveler} />}
      />
      <TravelerForm traveler={traveler} others={all.filter((t) => t.id !== id)} />
    </>
  );
}
