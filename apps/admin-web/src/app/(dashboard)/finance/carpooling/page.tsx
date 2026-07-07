'use client';

import { Lock } from 'lucide-react';
import { useCostPerKm, useCommission } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncSection } from '@/components/config/async-section';
import { CostPerKmPanel } from '@/components/pricing/cost-per-km-panel';
import { CarpoolingFeePanel } from '@/components/pricing/carpooling-fee-panel';
import { PricingSection } from '@/components/pricing/pricing-section';

/**
 * Carpooling — el carril COST-SHARING, separado de Precios on-demand porque NO comparte fórmula (ADR-017 §1.6 /
 * ADR-015 §11.2). Acá el conductor pone el precio del asiento; la plataforma solo fija el TECHO anti-lucro (el
 * costo de operación por km, escudo legal · F2.5) y el service fee que se suma al pasajero (F2.7). El costo/km
 * vive en booking-service; la comisión en payment-service. Gate de presentación con `pricing:view`; el admin-bff
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
        description="El carril cost-sharing: el conductor pone el precio del asiento y la plataforma solo limita el lucro. Acá fijás el techo anti-lucro (costo de operación por km) y el service fee al pasajero. Los cambios son globales, se aplican al instante y quedan auditados."
        breadcrumbs={[{ label: 'Precios' }, { label: 'Carpooling' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* Techo anti-lucro · el costo/km que limita el precio del asiento (escudo legal · per-país). */}
        <PricingSection
          title="Techo anti-lucro · costo de operación"
          hint="El costo de operación por km que limita el precio del asiento (escudo legal anti-lucro). Se fija por país; el conductor no puede cobrar por encima de (distancia × costo/km + peaje) ÷ asientos."
        >
          {/* F2.5 · costo/km del carpooling (costo de operación DIRECTO del admin, per-país). */}
          <AsyncSection query={costPerKmQuery} skeleton={<Skeleton className="mt-6 h-28" />}>
            {(data) => <CostPerKmPanel config={data} />}
          </AsyncSection>
        </PricingSection>

        {/* Comisión del carril · service fee al pasajero (el conductor cobra el 100% de su contribución). */}
        <PricingSection
          title="Comisión · service fee al pasajero"
          hint="Cómo gana la plataforma en el carpooling: un service fee que se suma al pasajero, sin tocar lo que cobra el conductor."
        >
          {/* F2.7 · service fee del carpooling (preserva la comisión on-demand en el mismo config · CAS). */}
          <AsyncSection query={commissionQuery} skeleton={<Skeleton className="mt-6 h-28" />}>
            {(data) => <CarpoolingFeePanel config={data} />}
          </AsyncSection>
        </PricingSection>
      </div>
    </div>
  );
}
