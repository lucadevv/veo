'use client';

import { Lock } from 'lucide-react';
import {
  useModeSchedule,
  useFuelSurcharge,
  useBaseFare,
  useCommission,
  useCostPerKm,
  useEnergyCatalog,
  useBidFloor,
} from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { ModeSchedulePanel } from '@/components/pricing/mode-schedule-panel';
import { FuelSurchargePanel } from '@/components/pricing/fuel-surcharge-panel';
import { BaseFarePanel } from '@/components/pricing/base-fare-panel';
import { CommissionPanel } from '@/components/pricing/commission-panel';
import { CostPerKmPanel } from '@/components/pricing/cost-per-km-panel';
import { EnergyCatalogPanel } from '@/components/pricing/energy-catalog-panel';
import { BidFloorPanel } from '@/components/pricing/bid-floor-panel';

/**
 * Modo de pricing global (PUJA↔FIJO · ADR 011). Vive bajo Finanzas: es decisión comercial/financiera.
 * Gate de presentación con `pricing:view`; el admin-bff (RolesGuard) y trip-service re-autorizan server-side.
 */
export default function PricingPage() {
  const user = useSession();
  const query = useModeSchedule();
  const fuelQuery = useFuelSurcharge();
  const baseFareQuery = useBaseFare();
  const commissionQuery = useCommission();
  const costPerKmQuery = useCostPerKm();
  const energyQuery = useEnergyCatalog();
  const bidFloorQuery = useBidFloor();

  if (!can(user, 'pricing:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Modo de pricing"
          breadcrumbs={[{ label: 'Finanzas' }, { label: 'Pricing' }]}
        />
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

        {/* B3 · recargo de combustible (mismo gate pricing:view; carga independiente del schedule). */}
        {fuelQuery.isError ? (
          <ErrorState onRetry={() => void fuelQuery.refetch()} />
        ) : fuelQuery.isLoading || !fuelQuery.data ? (
          <Skeleton className="mt-6 h-28" />
        ) : (
          <FuelSurchargePanel config={fuelQuery.data} />
        )}

        {/* F2.4 · tarifa base (banderazo + per-km + per-min; mismo gate pricing:view; carga independiente). */}
        {baseFareQuery.isError ? (
          <ErrorState onRetry={() => void baseFareQuery.refetch()} />
        ) : baseFareQuery.isLoading || !baseFareQuery.data ? (
          <Skeleton className="mt-6 h-28" />
        ) : (
          <BaseFarePanel config={baseFareQuery.data} />
        )}

        {/* F2.7 · comisión por modo (on-demand configurable + carpooling 0 legal-gated; carga independiente). */}
        {commissionQuery.isError ? (
          <ErrorState onRetry={() => void commissionQuery.refetch()} />
        ) : commissionQuery.isLoading || !commissionQuery.data ? (
          <Skeleton className="mt-6 h-28" />
        ) : (
          <CommissionPanel config={commissionQuery.data} />
        )}

        {/* F2.5 · costo/km del carpooling (costo de operación DIRECTO del admin, per-país; escudo legal). */}
        {costPerKmQuery.isError ? (
          <ErrorState onRetry={() => void costPerKmQuery.refetch()} />
        ) : costPerKmQuery.isLoading || !costPerKmQuery.data ? (
          <Skeleton className="mt-6 h-28" />
        ) : (
          <CostPerKmPanel config={costPerKmQuery.data} />
        )}

        {/* B5 · precios de energía multi-fuente (mismo gate pricing:view; carga independiente). */}
        {energyQuery.isError ? (
          <ErrorState onRetry={() => void energyQuery.refetch()} />
        ) : energyQuery.isLoading || !energyQuery.data ? (
          <Skeleton className="mt-6 h-28" />
        ) : (
          <EnergyCatalogPanel config={energyQuery.data} />
        )}

        {/* ADR 010 §9.3 · piso de la PUJA per-oferta (mismo gate pricing:view; carga independiente). */}
        {bidFloorQuery.isError ? (
          <ErrorState onRetry={() => void bidFloorQuery.refetch()} />
        ) : bidFloorQuery.isLoading || !bidFloorQuery.data ? (
          <Skeleton className="mt-6 h-28" />
        ) : (
          <BidFloorPanel config={bidFloorQuery.data} />
        )}
      </div>
    </div>
  );
}
