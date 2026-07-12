'use client';

import { Lock } from 'lucide-react';
import {
  useActiveCarpools,
  useCostPerKm,
  useCommission,
  useRevenueMetrics,
} from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncSection } from '@/components/config/async-section';
import { CostPerKmPanel } from '@/components/pricing/cost-per-km-panel';
import { CarpoolingFeePanel } from '@/components/pricing/carpooling-fee-panel';
import {
  CarpoolingMonitor,
  CarpoolingMonitorSkeleton,
  type CarpoolRevenue,
} from '@/components/finance/carpooling-monitor';

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
  const activeCarpoolsQuery = useActiveCarpools();
  const costPerKmQuery = useCostPerKm();
  const commissionQuery = useCommission();
  // Revenue del modo CARPOOLING para el 5º KPI del monitor (board TSqpB · "Fee recaudado"). Rango 30d — el
  // default que usa el resto de analytics (métricas). `byMode` es Σ netSettled = TOTAL liquidado, NO el fee: el
  // rótulo del KPI lo aclara. Query SEPARADA de los carpools activos → degrada sola (loading/error) sin tumbar
  // el monitor. Sin CARPOOLING en `byMode` (0 viajes en el rango) → 0 liquidado (honesto), no un hueco.
  const revenueQuery = useRevenueMetrics('30d');
  const carpoolRevenue: CarpoolRevenue = revenueQuery.data
    ? {
        status: 'ready',
        cents: revenueQuery.data.byMode.find((m) => m.mode === 'CARPOOLING')?.revenueCents ?? 0,
      }
    : revenueQuery.isError
      ? { status: 'error' }
      : { status: 'loading' };

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
        description="El viaje compartido: el conductor publica y los pasajeros reservan asiento. Acá se fija el service fee y el techo anti-lucro (costo/km)."
        breadcrumbs={[{ label: 'Precios' }, { label: 'Carpooling' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* MONITOREO (board veo.pen · TSqpB): 4 KPIs + tabla "Carpools activos", ENCIMA de los parámetros. Dato
            REAL de booking-service (ocupación/conteos/cupos); refresco en vivo. 4 estados vía AsyncSection
            (loading skeleton / error+retry / empty "sin carpools" dentro del panel / data). */}
        <div className="mt-2">
          <AsyncSection query={activeCarpoolsQuery} skeleton={<CarpoolingMonitorSkeleton />}>
            {(data) => <CarpoolingMonitor data={data} revenue={carpoolRevenue} />}
          </AsyncSection>
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
