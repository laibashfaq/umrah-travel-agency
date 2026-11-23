import type { ProfileDto } from '@umrah/shared';
import { PageHeader } from '@/components/layout/page-header';
import { ProfileForm } from '@/components/portal/profile-form';
import { portalData } from '@/lib/portal/api';

export const metadata = { title: 'Profile' };

export default async function ProfilePage() {
  const profile = await portalData<ProfileDto>('/profile');
  return (
    <>
      <PageHeader title="Profile" description="Your contact details and message preferences." />
      <ProfileForm profile={profile} />
    </>
  );
}
