import { LockKeyhole } from 'lucide-react';
import { EmptyState } from '@/components/feedback/states';

/** Shown inside the portal when the signed-in staff member lacks the permission for a page. The API enforces it regardless. */
export function Forbidden({ what = 'this page' }: { what?: string }) {
  return (
    <EmptyState
      icon={LockKeyhole}
      title="You do not have access"
      description={`Your role does not include permission to view ${what}. If you need it, ask a Super Admin.`}
    />
  );
}
