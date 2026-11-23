import { Laptop, ShieldCheck } from 'lucide-react';
import type { SessionInfo } from '@umrah/shared';
import { BackupCodesForm, ChangePasswordForm } from '@/components/auth/security-forms';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authApi, requireUser } from '@/lib/auth/server';
import { formatDateTime } from '@/lib/format';
import { revokeSessionAction, signOutOtherDevicesAction } from './actions';

export const metadata = { title: 'Security' };

/** Browser/OS summary from a user-agent string (display only). */
function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

export default async function SecurityPage() {
  const { user, accessToken } = await requireUser('STAFF');
  const sessions = await authApi<SessionInfo[]>('/auth/sessions', { token: accessToken });
  const list = sessions.ok ? sessions.data : [];

  return (
    <>
      <PageHeader title="Security" description="Protect your staff account." breadcrumbs={[{ label: 'Dashboard', href: '/admin' }, { label: 'Security' }]} />
      <div className="grid gap-6">
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4" aria-hidden /> Two-factor authentication</CardTitle>
            <CardDescription>Required for all staff. Status: <Badge variant={user.twoFactorEnabled ? 'secondary' : 'destructive'}>{user.twoFactorEnabled ? 'On' : 'Off'}</Badge></CardDescription>
          </CardHeader>
          <CardContent><h3 className="mb-3 font-sans text-sm font-semibold">Backup codes</h3><BackupCodesForm /></CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader><CardTitle className="text-base">Change password</CardTitle><CardDescription>You will stay signed in here; your other devices are signed out.</CardDescription></CardHeader>
          <CardContent><ChangePasswordForm identity={[user.email, user.firstName, user.lastName]} /></CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div><CardTitle className="text-base">Signed-in devices</CardTitle><CardDescription>Sign out any device you do not recognise.</CardDescription></div>
            {list.length > 1 && <form action={signOutOtherDevicesAction}><Button variant="outline" size="sm" type="submit">Sign out other devices</Button></form>}
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {list.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start gap-3">
                    <Laptop className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
                    <div className="text-sm">
                      <p className="font-medium">{deviceLabel(s.userAgent)} {s.current && <Badge variant="secondary" className="ms-1">This device</Badge>}</p>
                      <p className="text-muted-foreground">{s.ipAddress ?? 'Unknown location'} · signed in {formatDateTime(s.createdAt)}</p>
                    </div>
                  </div>
                  {!s.current && (
                    <form action={revokeSessionAction}><input type="hidden" name="id" value={s.id} /><Button variant="ghost" size="sm" type="submit">Sign out</Button></form>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
