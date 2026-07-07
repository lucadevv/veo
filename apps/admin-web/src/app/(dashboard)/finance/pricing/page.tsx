'use client';

import { Lock } from 'lucide-react';
import {
  useModeSchedule,
  useFuelSurcharge,
  useBaseFare,
  useCommission,
  useEnergyCatalog,
  useBidFloor,
} from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncSection } from '@/components/config/async-section';
import { ModeSchedulePanel } from '@/components/pricing/mode-schedule-panel';
import { FuelSurchargePanel } from '@/components/pricing/fuel-surcharge-panel';
import { BaseFarePanel } from '@/components/pricing/base-fare-panel';
import { OnDemandCommissionPanel } from '@/components/pricing/on-demand-commission-panel';
import { EnergyCatalogPanel } from '@/components/pricing/energy-catalog-panel';
import { BidFloorPanel } from '@/components/pricing/bid-floor-panel';
import { PricingSection } from '@/components/pricing/pricing-section';

/**
 * Precios on-demand — config financiera del carril TAXI (viaje inmediato), agrupada por sección (PricingSection):
 * Modo de tarifa (PUJA↔FIJO + piso de puja · ADR 011) · Componentes (tarifa base, recargo de combustible B4,
 * precios de energía B5) · Comisión al conductor. El carril CARPOOLING (cost-sharing) vive en su propia pantalla
 * (Finanzas › Carpooling): no comparte fórmula con on-demand. Gate de presentación con `pricing:view`; el
 * admin-bff (RolesGuard) y los servicios re-autorizan server-side.
 */
export default function PricingPage() {
  const user = useSession();
  const query = useModeSchedule();
  const fuelQuery = useFuelSurcharge();
  const baseFareQuery = useBaseFare();
  const commissionQuery = useCommission();
  const energyQuery = useEnergyCatalog();
  const bidFloorQuery = useBidFloor();

  if (!can(user, 'pricing:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Precios on-demand"
          breadcrumbs={[{ label: 'Precios' }, { label: 'Precios on-demand' }]}
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
        title="Precios on-demand"
        description="Configurá cómo se calcula y se cobra el viaje inmediato: modo, componentes de la tarifa y comisión al conductor. Todos los cambios son globales, se aplican al instante y quedan auditados."
        breadcrumbs={[{ label: 'Precios' }, { label: 'Precios on-demand' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* CARRIL on-demand · cómo se fija el precio del viaje inmediato (modo + piso de puja). */}
        <PricingSection
          title="Modo de tarifa · on-demand"
          hint="Cómo se fija el precio del viaje inmediato: puja del pasajero o precio fijo calculado, y el piso de la puja."
        >
          <AsyncSection
            query={query}
            skeleton={
              <div className="grid gap-3 pt-4 sm:grid-cols-2">
                <Skeleton className="h-28" />
                <Skeleton className="h-28" />
              </div>
            }
          >
            {(data) => <ModeSchedulePanel schedule={data} />}
          </AsyncSection>

          {/* ADR 010 §9.3 · piso de la PUJA per-oferta. */}
          <AsyncSection query={bidFloorQuery} skeleton={<Skeleton className="mt-6 h-28" />}>
            {(data) => <BidFloorPanel config={data} />}
          </AsyncSection>
        </PricingSection>

        {/* CARRIL on-demand · las piezas que arman la tarifa (base + recargo de combustible + energía). */}
        <PricingSection
          title="Componentes de la tarifa · on-demand"
          hint="Las piezas que arman el precio fijo y el sugerido de la puja: la tarifa base y el modelo de energía."
        >
          {/* F2.4 · tarifa base (banderazo + per-km + per-min). */}
          <AsyncSection query={baseFareQuery} skeleton={<Skeleton className="mt-6 h-28" />}>
            {(data) => <BaseFarePanel config={data} />}
          </AsyncSection>

          {/* B3/B4 · recargo de combustible (modelo de energía LIVE mientras el flip esté OFF). */}
          <AsyncSection query={fuelQuery} skeleton={<Skeleton className="mt-6 h-28" />}>
            {(data) => <FuelSurchargePanel config={data} />}
          </AsyncSection>

          {/* B5 · precios de energía multi-fuente (vista previa hasta el flip). */}
          <AsyncSection query={energyQuery} skeleton={<Skeleton className="mt-6 h-28" />}>
            {(data) => <EnergyCatalogPanel config={data} />}
          </AsyncSection>
        </PricingSection>

        {/* on-demand · cómo gana la plataforma en el viaje inmediato (descuento al conductor). */}
        <PricingSection
          title="Comisión · on-demand"
          hint="Cómo gana la plataforma en el viaje inmediato: la comisión que se descuenta al conductor. El service fee del carpooling se configura en Finanzas › Carpooling."
        >
          {/* F2.7 · comisión on-demand (preserva el service fee del carpooling en el mismo config · CAS). */}
          <AsyncSection query={commissionQuery} skeleton={<Skeleton className="mt-6 h-28" />}>
            {(data) => <OnDemandCommissionPanel config={data} />}
          </AsyncSection>
        </PricingSection>
      </div>
    </div>
  );
}
