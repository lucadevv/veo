'use client';

import { Lock, ShieldCheck } from 'lucide-react';
import { useModeSchedule, useBaseFare, useCommission } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncSection } from '@/components/config/async-section';
import { ModeSchedulePanel } from '@/components/pricing/mode-schedule-panel';
import { BaseFarePanel } from '@/components/pricing/base-fare-panel';
import { OnDemandCommissionPanel } from '@/components/pricing/on-demand-commission-panel';

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
  const query = useModeSchedule();
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
        description="El carril del viaje inmediato. Corre en DOS modos que coexisten — FIJO (tarifa calculada, estilo Uber) y PUJA (el pasajero ofrece su precio, estilo inDrive). Acá va la config global: tarifa base, comisión y el modo por horario. El piso de la puja se configura por servicio en Ofertas de servicio."
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
          {/* F2.4 · tarifa base (banderazo + per-km + per-min). El por-km es ÚNICO y all-in (incluye el
              combustible), como Uber. El modelo de energía/combustible se sacó: era una variable de más que se
              sumaba al per-km (riesgo de doble-cuenta) y no existe en la fórmula canónica del mercado. */}
          <AsyncSection query={baseFareQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <BaseFarePanel config={data} />}
          </AsyncSection>

          {/* El piso de la PUJA se configura por servicio en Ofertas de servicio (no acá): es un dato per-oferta,
              no un global. Acá quedan la fórmula (compartida) y la comisión (transversal). */}
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
