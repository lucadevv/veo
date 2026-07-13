'use client';

import { Lock } from 'lucide-react';
import { useBaseFare, useCommission } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncSection } from '@/components/config/async-section';
import { BaseFarePanel } from '@/components/pricing/base-fare-panel';
import { FareSimulatorCard } from '@/components/pricing/fare-simulator-card';
import { OnDemandCommissionPanel } from '@/components/pricing/on-demand-commission-panel';

/**
 * Encabezado de sección: separa visualmente los grupos de config (línea divisoria + label + aclaración).
 * El ORDEN cuenta la historia: primero el modo (selector), después las piezas agrupadas por lo que hacen.
 */
function SectionHeader({ label }: { label: string }) {
  return (
    <div className="border-t border-border pt-5">
      <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-ink-subtle">{label}</h2>
    </div>
  );
}

/**
 * Precios on-demand — config financiera del carril TAXI (viaje inmediato). Secciones planas e independientes:
 * modo de tarificación, tarifa base y comisión on-demand. El por-km de la tarifa base es ÚNICO y all-in (incluye
 * combustible), como la fórmula canónica de Uber — se sacó el modelo de energía/combustible (variable de más que
 * se sumaba al per-km, riesgo de doble-cuenta). Cada card es una MUTACIÓN separada (su propio endpoint, CAS y
 * step-up MFA) — el banner superior lo hace explícito. El piso de la PUJA se configura POR SERVICIO en "Ofertas
 * de servicio" (no acá): es un dato per-oferta, no un global. El carril CARPOOLING vive en Finanzas › Carpooling. Gate de
 * presentación con `pricing:view`; el admin-bff (RolesGuard) y los servicios re-autorizan server-side.
 */
export default function PricingPage() {
  const user = useSession();
  const baseFareQuery = useBaseFare();
  const commissionQuery = useCommission();

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
        breadcrumbs={[{ label: 'Precios' }, { label: 'Precios on-demand' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* El orden cuenta la historia (veo.pen): la FÓRMULA (compartida) y después la comisión (transversal).
            El MODO (FIJO/PUJA) ya no vive acá — con ADR-023 es una palanca per-oferta en Ofertas de servicio. */}
        <div className="stagger mt-5 space-y-5">
          {/* La FÓRMULA es UNA sola: el precio exacto en FIJO y el sugerido que ve el pasajero en PUJA. */}
          <SectionHeader label="Fórmula de tarifa" />
          {/* F2.4 · tarifa base (banderazo + per-km + per-min). El por-km es ÚNICO y all-in (incluye el
              combustible), como Uber. El modelo de energía/combustible se sacó: era una variable de más que se
              sumaba al per-km (riesgo de doble-cuenta) y no existe en la fórmula canónica del mercado. */}
          <AsyncSection query={baseFareQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => (
              <div className="space-y-5">
                <BaseFarePanel config={data} />
                {/* Simulador (veo.pen cuH7M): preview de la fórmula con la MISMA data persistida (no el draft). */}
                <FareSimulatorCard config={data} />
              </div>
            )}
          </AsyncSection>

          {/* El piso de la PUJA se configura por servicio en Ofertas de servicio (no acá): es un dato per-oferta,
              no un global. Acá quedan la fórmula (compartida) y la comisión (transversal). */}
          {/* Transversal: la comisión vive aguas abajo de fareCents — misma tasa venga de un bid (PUJA) o un cálculo (FIJO). */}
          <SectionHeader label="Comisión" />
          <AsyncSection query={commissionQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <OnDemandCommissionPanel config={data} />}
          </AsyncSection>
        </div>
      </div>
    </div>
  );
}
