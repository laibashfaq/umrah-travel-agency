import type { TravelerDto } from '@umrah/shared';
import { PageHeader } from '@/components/layout/page-header';
import { TravelerForm } from '@/components/portal/traveler-form';
import { safeNextPath } from '@/lib/auth/config';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Add traveler' };

export default async function NewTravelerPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo } = await searchParams;
  const others = await portalData<TravelerDto[]>('/travelers');
  return (
    <>
      <PageHeader title="Add traveler" breadcrumbs={[{ label: 'Travelers', href: '/account/travelers' }, { label: 'Add' }]} />
      <TravelerForm others={others} returnTo={returnTo ? safeNextPath(returnTo, '/account/travelers') : undefined} />
    </>
  );
}
