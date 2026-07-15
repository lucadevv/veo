'use client';

import { useDispatchRadiusConfig } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { AdminTopbar } from '@/components/layout/admin-topbar';
import { ErrorState, PermissionState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { useRequestAccess } from '@/lib/use-request-access';
import { RadiusConfigPanel } from '@/components/dispatch/radius-config-panel';

/**
 * Config de RADIOS (k-rings) + ventanas de dispatch. Palanca operativa del despacho (feed del mapa + alcance
 * de pujas). Gate de presentación con `dispatch:view`; el admin-bff (RolesGuard) y dispatch-service re-autorizan.
 */
export default function DispatchRadiusPage() {
  const user = useSession();
  const requestAccess = useRequestAccess();
  const query = useDispatchRadiusConfig();

  const topbar = (
    <AdminTopbar title="Radios de dispatch" />
  );

  if (!can(user, 'dispatch:view')) {
    return (
      <div className="flex h-full flex-col">
        {topbar}
        <PermissionState
          className="flex-1"
          section="Radios de dispatch"
          permission="dispatch:view"
          onRequest={() => requestAccess('dispatch:view')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {topbar}
      <div className="flex flex-1 flex-col overflow-y-auto p-7">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.isLoading || !query.data ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-40 rounded-[20px]" />
            <Skeleton className="h-40 rounded-[20px]" />
          </div>
        ) : (
          <RadiusConfigPanel config={query.data} />
        )}
      </div>
    </div>
  );
}
