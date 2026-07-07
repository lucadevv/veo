'use client';

import { Lock, ShieldCheck } from 'lucide-react';
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

/**
 * Precios on-demand — config financiera del carril TAXI (viaje inmediato). El diseño (veo.pen) apila las
 * secciones como cards PLANAS e independientes: tarifa base, comisión on-demand, recargo de combustible/energía,
 * modo de tarificación y catálogo de energía. Cada card es una MUTACIÓN separada (su propio endpoint, CAS y
 * step-up MFA) — el banner superior lo hace explícito. El piso de la PUJA se configura en "Tarifas por oferta"
 * (default global + overrides por oferta). El carril CARPOOLING vive en Finanzas › Carpooling. Gate de
 * presentación con `pricing:view`; el admin-bff (RolesGuard) y los servicios re-autorizan server-side.
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
        description="El carril del viaje inmediato. Corre en DOS modos que coexisten — FIJO (tarifa calculada, estilo Uber) y PUJA (el pasajero ofrece su precio, estilo inDrive). Acá va la config global de ambos: tarifa base, comisión, recargo, el modo por horario y el piso de la puja. Cambios globales, al instante y auditados."
        breadcrumbs={[{ label: 'Precios' }, { label: 'Precios on-demand' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* Aviso de step-up: cada card guarda por separado, con su propia mutación + MFA. */}
        <div className="flex items-start gap-3 rounded-lg border border-brand/30 bg-brand/12 p-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold text-ink">
              Cada sección guarda por separado, con step-up MFA
            </p>
            <p className="text-xs text-ink-subtle">
              Cada card es una mutación independiente (su propio endpoint y versión): al guardar te pide
              tu código TOTP y el cambio queda auditado. No hay un guardado global.
            </p>
          </div>
        </div>

        {/* Cards planas, en el orden del diseño (veo.pen). Cada una es su propia mutación con CAS + step-up. */}
        <div className="mt-5 space-y-5">
          {/* F2.4 · tarifa base (banderazo + per-km + per-min). */}
          <AsyncSection query={baseFareQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <BaseFarePanel config={data} />}
          </AsyncSection>

          {/* F2.7 · comisión on-demand (preserva el service fee del carpooling en el mismo config · CAS). */}
          <AsyncSection query={commissionQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <OnDemandCommissionPanel config={data} />}
          </AsyncSection>

          {/* B3/B4 · recargo de combustible (modelo de energía LIVE mientras el flip esté OFF). */}
          <AsyncSection query={fuelQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <FuelSurchargePanel config={data} />}
          </AsyncSection>

          {/* Modo de tarificación global (PUJA↔FIJO) + franjas horarias. */}
          <AsyncSection query={query} skeleton={<Skeleton className="h-64" />}>
            {(data) => <ModeSchedulePanel schedule={data} />}
          </AsyncSection>

          {/* Piso de la PUJA por DEFECTO global — co-locado con el modo (puja = modo + su piso). Los overrides
              POR servicio viven en "Ofertas de servicio"; misma config /pricing/bid-floor con su propio CAS. */}
          <AsyncSection query={bidFloorQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <BidFloorPanel config={data} />}
          </AsyncSection>

          {/* B5 · catálogo de energía multi-fuente (vista previa hasta el flip). */}
          <AsyncSection query={energyQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <EnergyCatalogPanel config={data} />}
          </AsyncSection>
        </div>
      </div>
    </div>
  );
}
