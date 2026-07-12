'use client';

import { Lock } from 'lucide-react';
import { useBaseFare, useBidFloor, useCatalog } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncSection } from '@/components/config/async-section';
import { CatalogPanel } from '@/components/catalog/catalog-panel';

/**
 * Ofertas de servicio (ADR 013 · Fase B / A1). Vive bajo Finanzas: la disponibilidad y el precio de los
 * servicios es decisión comercial/operativa. A1 unifica acá los DOS mínimos por oferta que antes vivían
 * partidos: la tarifa mínima FIJA (catálogo) y el piso de la PUJA (Precios) — el operador los ve juntos y
 * con validación cruzada. Gate de presentación con `catalog:view`; el admin-bff (RolesGuard) + trip-service
 * re-autorizan server-side. El pasajero ve, cotiza y pide solo con lo configurado acá (server-driven).
 */
export default function CatalogPage() {
  const user = useSession();
  const catalogQuery = useCatalog();
  const bidFloorQuery = useBidFloor();
  // Tarifa base GLOBAL: SOLO para el placeholder de los params a medida del catálogo (muestra el número que se
  // usa si el campo queda vacío). Su fallo/carga NO tumba nada — el placeholder cae a "global".
  const baseFareQuery = useBaseFare();

  if (!can(user, 'catalog:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Ofertas de servicio"
          breadcrumbs={[{ label: 'Precios' }, { label: 'Ofertas de servicio' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver las ofertas de servicio."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Ofertas de servicio"
        description="El menú de servicios que el pasajero puede pedir. Cada uno hereda la fórmula global y ajusta su modo, mínimos y disponibilidad."
        breadcrumbs={[{ label: 'Precios' }, { label: 'Ofertas de servicio' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <div className="mt-2 space-y-5">
          {/*
            DESACOPLE de carriles: la LISTA de ofertas (catálogo: enable/disable, modo, multiplicador, tarifa
            mínima) depende SOLO de `catalogQuery`. El piso de la PUJA es OTRA config (endpoint + CAS propios):
            si `/pricing/bid-floor` falla o carga, NO debe tumbar la lista entera — solo degrada su columna.
            Por eso el bidFloor entra como POSIBLEMENTE undefined (loading o error) y CatalogPanel degrada esa
            columna con "no disponible / reintentá", manteniendo operativo todo lo demás.
          */}
          <AsyncSection
            query={catalogQuery}
            skeleton={
              <div className="grid gap-5 pt-4 [grid-template-columns:repeat(auto-fill,minmax(20rem,1fr))]">
                <Skeleton className="h-72 rounded-xl" />
                <Skeleton className="h-72 rounded-xl" />
                <Skeleton className="h-72 rounded-xl" />
              </div>
            }
          >
            {(catalog) => (
              <CatalogPanel
                catalog={catalog}
                bidFloor={bidFloorQuery.data}
                baseFare={baseFareQuery.data}
                onRetryBidFloor={() => void bidFloorQuery.refetch()}
              />
            )}
          </AsyncSection>
        </div>
      </div>
    </div>
  );
}
