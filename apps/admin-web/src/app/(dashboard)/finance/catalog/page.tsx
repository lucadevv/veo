'use client';

import { Lock } from 'lucide-react';
import { useBidFloor, useCatalog } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { AsyncSection } from '@/components/config/async-section';
import { CatalogPanel } from '@/components/catalog/catalog-panel';

/**
 * Tarifas por oferta (ADR 013 · Fase B / A1). Vive bajo Finanzas: la disponibilidad y el precio de los
 * servicios es decisión comercial/operativa. A1 unifica acá los DOS mínimos por oferta que antes vivían
 * partidos: la tarifa mínima FIJA (catálogo) y el piso de la PUJA (Precios) — el operador los ve juntos y
 * con validación cruzada. Gate de presentación con `catalog:view`; el admin-bff (RolesGuard) + trip-service
 * re-autorizan server-side. El pasajero ve, cotiza y pide solo con lo configurado acá (server-driven).
 */
export default function CatalogPage() {
  const user = useSession();
  const catalogQuery = useCatalog();
  const bidFloorQuery = useBidFloor();

  if (!can(user, 'catalog:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Tarifas por oferta"
          breadcrumbs={[{ label: 'Finanzas' }, { label: 'Tarifas por oferta' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver las tarifas por oferta."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Tarifas por oferta"
        description="Configurá cada servicio en un solo lugar: disponibilidad, modo, multiplicador y los dos mínimos (tarifa fija y piso de puja). El pasajero ve y cotiza solo lo habilitado."
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Tarifas por oferta' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <AsyncSection
          query={catalogQuery}
          skeleton={
            <div className="grid gap-3 pt-4">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          }
        >
          {(catalog) => (
            <AsyncSection
              query={bidFloorQuery}
              skeleton={
                <div className="grid gap-3 pt-4">
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                </div>
              }
            >
              {(bidFloor) => <CatalogPanel catalog={catalog} bidFloor={bidFloor} />}
            </AsyncSection>
          )}
        </AsyncSection>
      </div>
    </div>
  );
}
