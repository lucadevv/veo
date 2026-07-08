'use client';

import { Lock, ShieldCheck } from 'lucide-react';
import { useCostPerKm, useCommission } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncSection } from '@/components/config/async-section';
import { CostPerKmPanel } from '@/components/pricing/cost-per-km-panel';
import { CarpoolingFeePanel } from '@/components/pricing/carpooling-fee-panel';

/**
 * Carpooling — el carril COST-SHARING, separado de Precios on-demand porque NO comparte fórmula (ADR-017 §1.6 /
 * ADR-015 §11.2). El diseño (veo.pen) apila las secciones como cards PLANAS e independientes: el service fee al
 * pasajero (F2.7) y el costo de operación por km (escudo legal anti-lucro · F2.5). Acá el conductor pone el
 * precio del asiento; la plataforma solo fija el TECHO anti-lucro y el service fee. Cada card es una MUTACIÓN
 * separada (su propio endpoint, CAS y step-up MFA) — el banner superior lo hace explícito. El costo/km vive en
 * booking-service; la comisión en payment-service. Gate de presentación con `pricing:view`; el admin-bff
 * (RolesGuard) + cada servicio re-autorizan server-side. Nada se decide en la UI.
 */
export default function CarpoolingPage() {
  const user = useSession();
  const costPerKmQuery = useCostPerKm();
  const commissionQuery = useCommission();

  if (!can(user, 'pricing:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Carpooling"
          breadcrumbs={[{ label: 'Precios' }, { label: 'Carpooling' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver la config del carpooling."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Carpooling"
        description="El viaje compartido y programado: el conductor publica un viaje y los pasajeros reservan asiento. Siempre en modo FIJO y con reparto de costos —el conductor pone el precio del asiento y VEO solo evita que haya lucro—. Acá se fija el service fee al pasajero y el techo anti-lucro (el costo de operar el vehículo por km). Cambios globales, al instante y auditados."
        breadcrumbs={[{ label: 'Precios' }, { label: 'Carpooling' }]}
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
              Cada card es una mutación independiente (su propio endpoint y versión): al guardar te
              pide tu código TOTP y el cambio queda auditado. No hay un guardado global.
            </p>
          </div>
        </div>

        {/* Cards planas, en el orden del diseño (veo.pen). Cada una es su propia mutación con CAS + step-up. */}
        <div className="mt-5 space-y-5">
          {/* F2.7 · service fee del carpooling (preserva la comisión on-demand en el mismo config · CAS). */}
          <AsyncSection query={commissionQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <CarpoolingFeePanel config={data} />}
          </AsyncSection>

          {/* F2.5 · costo/km del carpooling (costo de operación DIRECTO del admin, per-país · CAS por país). */}
          <AsyncSection query={costPerKmQuery} skeleton={<Skeleton className="h-64" />}>
            {(data) => <CostPerKmPanel config={data} />}
          </AsyncSection>
        </div>
      </div>
    </div>
  );
}
