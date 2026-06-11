'use client';

import { Lock } from 'lucide-react';
import { useDispatchRadiusConfig } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { RadiusConfigPanel } from '@/components/dispatch/radius-config-panel';

/**
 * Config de RADIOS (k-rings) de dispatch. Vive bajo Operación: es palanca operativa del despacho.
 * Gate de presentación con `dispatch:view`; el admin-bff (RolesGuard) y dispatch-service re-autorizan
 * server-side.
 */
export default function DispatchRadiusPage() {
  const user = useSession();
  const query = useDispatchRadiusConfig();

  if (!can(user, 'dispatch:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Radios de dispatch"
          breadcrumbs={[{ label: 'Operación' }, { label: 'Radios de dispatch' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol DISPATCHER, ADMIN o SUPERADMIN para ver los radios de dispatch."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Radios de dispatch"
        description="Ajusta hasta dónde se buscan conductores: el feed del mapa y el alcance de las pujas."
        breadcrumbs={[{ label: 'Operación' }, { label: 'Radios de dispatch' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.isLoading || !query.data ? (
          <div className="grid gap-3 pt-4 sm:grid-cols-2">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : (
          <RadiusConfigPanel config={query.data} />
        )}
      </div>
    </div>
  );
}
