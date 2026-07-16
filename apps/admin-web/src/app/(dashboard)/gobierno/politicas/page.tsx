'use client';

import { usePolicies } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { useRequestAccess } from '@/lib/use-request-access';
import { Skeleton } from '@/components/ui/skeleton';
import { PoliciesPanel } from '@/components/gobierno/policies-panel';

/**
 * Gobierno → Políticas (PBAC · ADR-024). El registro de las 16 políticas de gobierno agrupadas por familia.
 * Gate de presentación con `gobierno:manage` (→ SUPERADMIN); el admin-bff (@Roles(SUPERADMIN)) y el PUT
 * (@RequireStepUpMfa) re-autorizan server-side. Las 8 políticas NET-NEW se marcan "en desarrollo" (aún sin
 * enforcement · ADR-024 §5) para no dar a entender que ya operan.
 */
export default function PoliciesPage() {
  const user = useSession();
  const canManage = can(user, 'gobierno:manage');
  const requestAccess = useRequestAccess();
  const query = usePolicies();

  if (!canManage) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Políticas"
          breadcrumbs={[{ label: 'Gobierno' }, { label: 'Políticas' }]}
        />
        <PermissionState
          className="flex-1"
          section="Políticas"
          permission="gobierno:manage"
          onRequest={() => requestAccess('gobierno:manage')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Políticas"
        breadcrumbs={[{ label: 'Gobierno' }, { label: 'Políticas' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.isLoading || !query.data ? (
          <div className="flex flex-col gap-4 pt-4">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        ) : query.data.length === 0 ? (
          // `data=[]` es truthy → sin este branch el panel renderiza 0 filas (card en blanco con solo los chips).
          <EmptyState
            className="pt-16"
            title="Sin políticas"
            description="El registro de políticas de gobierno está vacío. Aún no hay ninguna política configurada."
          />
        ) : (
          <PoliciesPanel policies={query.data} canManage={canManage} />
        )}
      </div>
    </div>
  );
}
