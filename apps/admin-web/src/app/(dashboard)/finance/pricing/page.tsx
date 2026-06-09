'use client';

import { Lock } from 'lucide-react';
import { useModeSchedule } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { ModeSchedulePanel } from '@/components/pricing/mode-schedule-panel';

/**
 * Modo de pricing global (PUJA↔FIJO · ADR 011). Vive bajo Finanzas: es decisión comercial/financiera.
 * Gate de presentación con `pricing:view`; el admin-bff (RolesGuard) y trip-service re-autorizan server-side.
 */
export default function PricingPage() {
  const user = useSession();
  const query = useModeSchedule();

  if (!can(user, 'pricing:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Modo de pricing" breadcrumbs={[{ label: 'Finanzas' }, { label: 'Pricing' }]} />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver el modo de pricing."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Modo de pricing"
        description="Elige cómo se fija la tarifa de los viajes: puja del pasajero o precio fijo calculado."
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Pricing' }]}
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
          <ModeSchedulePanel schedule={query.data} />
        )}
      </div>
    </div>
  );
}
