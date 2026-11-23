import type { RoleDto } from '@umrah/shared';
import { Forbidden } from '@/components/auth/forbidden';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminData, staffPage } from '@/lib/admin/api';

export const metadata = { title: 'Roles & permissions' };

export default async function RolesPage() {
  const { allowed } = await staffPage('roles:read');
  if (!allowed) return <Forbidden what="roles" />;
  const roles = await adminData<RoleDto[]>('/roles');
  return (
    <>
      <PageHeader title="Roles & permissions" description="What each role can do. Roles are defined in the product and applied to staff accounts." />
      <div className="grid gap-4">
        {roles.map((r) => {
          const modules = new Map<string, string[]>();
          for (const p of r.permissions) {
            const [m, a] = p.split(':') as [string, string];
            modules.set(m, [...(modules.get(m) ?? []), a]);
          }
          return (
            <Card key={r.id} className="shadow-card">
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                  <span>{r.name}</span>
                  <span className="text-sm font-normal text-muted-foreground">{r.userCount} staff member{r.userCount === 1 ? '' : 's'}</span>
                </CardTitle>
                {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
              </CardHeader>
              <CardContent>
                <details>
                  <summary className="cursor-pointer text-sm font-medium">{r.permissions.length} permissions in {modules.size} areas</summary>
                  <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                    {[...modules.entries()].map(([m, actions]) => (
                      <li key={m} className="flex flex-wrap items-center gap-1.5"><span className="w-28 font-medium">{m}</span>{actions.map((a) => <Badge key={a} variant="outline">{a}</Badge>)}</li>
                    ))}
                  </ul>
                </details>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
