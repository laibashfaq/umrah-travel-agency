import { Forbidden } from '@/components/auth/forbidden';
import { PackageForm } from '@/components/admin/package-forms';
import { PageHeader } from '@/components/layout/page-header';
import { staffPage } from '@/lib/admin/api';

export const metadata = { title: 'New package' };

export default async function NewPackagePage() {
  const { allowed } = await staffPage('packages:create');
  if (!allowed) return <Forbidden what="creating packages" />;
  return (
    <>
      <PageHeader title="New package" description="It starts as a draft. Add a departure with prices, then publish." breadcrumbs={[{ label: 'Packages', href: '/admin/packages' }, { label: 'New' }]} />
      <PackageForm />
    </>
  );
}
