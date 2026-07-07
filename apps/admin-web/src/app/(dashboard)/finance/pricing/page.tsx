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
 * Encabezado de sección: separa visualmente los grupos de config (línea divisoria + label + aclaración).
 * El ORDEN cuenta la historia: primero el modo (selector), después las piezas agrupadas por lo que hacen.
 */
function SectionHeader({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="border-t border-border pt-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        {label} <span className="font-normal normal-case tracking-normal">· {hint}</span>
      </h2>
    </div>
  );
}

/**
 * Precios on-demand — config financiera del carril TAXI (viaje inmediato). El diseño (veo.pen) apila las
 * secciones como cards PLANAS e independientes: tarifa base, comisión on-demand, recargo de combustible/energía,
 * modo de tarificación y catálogo de energía. Cada card es una MUTACIÓN separada (su propio endpoint, CAS y
 * step-up MFA) — el banner superior lo hace explícito. El piso de la PUJA por DEFECTO se edita acá (junto al
 * modo); los overrides POR SERVICIO viven en "Ofertas de servicio". El carril CARPOOLING vive en Finanzas › Carpooling. Gate de
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

        {/* El orden cuenta la historia (veo.pen): el MODO arriba (el selector), después las piezas agrupadas por
            lo que hacen — la fórmula (compartida), el piso (solo puja) y la comisión (transversal). */}
        <div className="mt-5 space-y-5">
          {/* EL SELECTOR: qué modo corre (PUJA↔FIJO) por franja horaria — resolve-once por viaje. */}
          <AsyncSection query={query} skeleton={<Skeleton className="h-64" />}>
            {(data) => <ModeSchedulePanel schedule={data} />}
          </AsyncSection>

          {/* La FÓRMULA es UNA sola: el precio exacto en FIJO y el sugerido que ve el pasajero en PUJA. */}
          <SectionHeader
            label="Fórmula de tarifa"
            hint="el precio exacto en FIJO · el sugerido que ve el pasajero en PUJA"
          />
          {/* F2.4 · tarifa base (banderazo + per-km + per-min). */}
          <AsyncSection query={baseFareQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <BaseFarePanel config={data} />}
          </AsyncSection>
          {/* B3/B4 · recargo de combustible (modelo de energía LIVE mientras el flip esté OFF). */}
          <AsyncSection query={fuelQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <FuelSurchargePanel config={data} />}
          </AsyncSection>
          {/* B5 · catálogo de energía multi-fuente (vista previa hasta el flip). */}
          <AsyncSection query={energyQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <EnergyCatalogPanel config={data} />}
          </AsyncSection>

          {/* Lo ÚNICO exclusivo de PUJA: el piso (gate duro del bid). Overrides por servicio en Ofertas de servicio. */}
          <SectionHeader
            label="Piso de la puja"
            hint="solo aplica en modo PUJA · el mínimo que el pasajero puede ofrecer"
          />
          <AsyncSection query={bidFloorQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <BidFloorPanel config={data} />}
          </AsyncSection>

          {/* Transversal: la comisión vive aguas abajo de fareCents — misma tasa venga de un bid (PUJA) o un cálculo (FIJO). */}
          <SectionHeader
            label="Comisión"
            hint="igual en FIJO y en PUJA · se descuenta al conductor"
          />
          <AsyncSection query={commissionQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <OnDemandCommissionPanel config={data} />}
          </AsyncSection>
        </div>
      </div>
    </div>
  );
}
