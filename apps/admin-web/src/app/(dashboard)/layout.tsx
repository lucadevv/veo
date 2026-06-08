import { redirect } from 'next/navigation';
import { getSession } from '@/lib/server/session';
import { Providers } from '@/components/providers';
import { SessionProvider } from '@/lib/session-context';
import { OpsRealtimeProvider } from '@/lib/realtime/ops-provider';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { PanicBanner } from '@/components/security/panic-banner';

export const dynamic = 'force-dynamic';

/**
 * Layout autoritativo del dashboard. Valida la sesión contra el admin-bff (GET /auth/session)
 * y, si no hay sesión, redirige a /login. Provee sessionUser (RBAC), React Query, tema, toasts
 * y la conexión de tiempo real /ops (banner de pánico global).
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <Providers>
      <SessionProvider user={session}>
        <OpsRealtimeProvider>
          <div className="flex h-screen overflow-hidden bg-bg">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <Topbar />
              <PanicBanner />
              <main className="flex-1 overflow-y-auto">{children}</main>
            </div>
          </div>
        </OpsRealtimeProvider>
      </SessionProvider>
    </Providers>
  );
}
