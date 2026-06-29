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
import { PricingSection } from '@/components/pricing/pricing-section';

/**
 * Precios y tarifas — config financiera de AMBOS carriles, agrupada por sección (PricingSection):
 * Modo de tarifa (PUJA↔FIJO + piso de puja · ADR 011) · Componentes on-demand (tarifa base, recargo de
 * combustible B4, precios de energía B5) · Carpooling (costo/km del cost-sharing) · Comisión (ambos modos).
 * Gate de presentación con `pricing:view`; el admin-bff (RolesGuard) y los servicios re-autorizan server-side.
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
          title="Precios y tarifas"
          breadcrumbs={[{ label: 'Finanzas' }, { label: 'Precios' }]}
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
        title="Precios y tarifas"
        description="Configurá cómo se calcula y se cobra cada viaje: modo, componentes de la tarifa on-demand, costo del carpooling y comisión."
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Precios' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* CARRIL on-demand · cómo se fija el precio del viaje inmediato (modo + piso de puja). */}
        <PricingSection
          title="Modo de tarifa · on-demand"
          hint="Cómo se fija el precio del viaje inmediato: puja del pasajero o precio fijo calculado, y el piso de la puja."
        >
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

          {/* ADR 010 §9.3 · piso de la PUJA per-oferta. */}
          {bidFloorQuery.isError ? (
            <ErrorState onRetry={() => void bidFloorQuery.refetch()} />
          ) : bidFloorQuery.isLoading || !bidFloorQuery.data ? (
            <Skeleton className="mt-6 h-28" />
          ) : (
            <BidFloorPanel config={bidFloorQuery.data} />
          )}
        </PricingSection>

        {/* CARRIL on-demand · las piezas que arman la tarifa (base + recargo de combustible + energía). */}
        <PricingSection
          title="Componentes de la tarifa · on-demand"
          hint="Las piezas que arman el precio fijo y el sugerido de la puja: tarifa base, recargo de combustible y el modelo de energía."
        >
          {/* F2.4 · tarifa base (banderazo + per-km + per-min). */}
          {baseFareQuery.isError ? (
            <ErrorState onRetry={() => void baseFareQuery.refetch()} />
          ) : baseFareQuery.isLoading || !baseFareQuery.data ? (
            <Skeleton className="mt-6 h-28" />
          ) : (
            <BaseFarePanel config={baseFareQuery.data} />
          )}

          {/* B3/B4 · recargo de combustible (modelo de energía LIVE mientras el flip esté OFF). */}
          {fuelQuery.isError ? (
            <ErrorState onRetry={() => void fuelQuery.refetch()} />
          ) : fuelQuery.isLoading || !fuelQuery.data ? (
            <Skeleton className="mt-6 h-28" />
          ) : (
            <FuelSurchargePanel config={fuelQuery.data} />
          )}

          {/* B5 · precios de energía multi-fuente (vista previa hasta el flip). */}
          {energyQuery.isError ? (
            <ErrorState onRetry={() => void energyQuery.refetch()} />
          ) : energyQuery.isLoading || !energyQuery.data ? (
            <Skeleton className="mt-6 h-28" />
          ) : (
            <EnergyCatalogPanel config={energyQuery.data} />
          )}
        </PricingSection>

        {/* CARRIL carpooling · el costo/km que limita el cost-sharing (escudo legal anti-lucro). */}
        <PricingSection
          title="Carpooling · programado"
          hint="El costo de operación por km que limita el precio del cost-sharing (escudo legal anti-lucro). Se fija por país."
        >
          {/* F2.5 · costo/km del carpooling (costo de operación DIRECTO del admin, per-país). */}
          {costPerKmQuery.isError ? (
            <ErrorState onRetry={() => void costPerKmQuery.refetch()} />
          ) : costPerKmQuery.isLoading || !costPerKmQuery.data ? (
            <Skeleton className="mt-6 h-28" />
          ) : (
            <CostPerKmPanel config={costPerKmQuery.data} />
          )}
        </PricingSection>

        {/* AMBOS modos · cómo gana la plataforma en cada carril (descuento on-demand vs service fee carpooling). */}
        <PricingSection
          title="Comisión · ambos modos"
          hint="Cómo gana la plataforma en cada carril: descuento al conductor en on-demand, service fee al pasajero en carpooling."
        >
          {/* F2.7 · comisión por modo (on-demand + service fee carpooling, ambas editables). */}
          {commissionQuery.isError ? (
            <ErrorState onRetry={() => void commissionQuery.refetch()} />
          ) : commissionQuery.isLoading || !commissionQuery.data ? (
            <Skeleton className="mt-6 h-28" />
          ) : (
            <CommissionPanel config={commissionQuery.data} />
          )}
        </PricingSection>
      </div>
    </div>
  );
}
