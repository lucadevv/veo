'use client';

import { Lock, ShieldCheck } from 'lucide-react';
import { useBidFloor, useCatalog } from '@/lib/api/queries';
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
        description="El menú de servicios que el pasajero puede pedir (VEO Moto, Económico…). Cada servicio hereda la config global de On-demand y puede overridear su modo, sus mínimos (tarifa fija y piso de puja) y activarse/desactivarse. Es el catálogo, no un carril de precio."
        breadcrumbs={[{ label: 'Precios' }, { label: 'Ofertas de servicio' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* Aviso de step-up (mismo patrón que Precios on-demand): el catálogo y el piso de la puja son DOS
            configs con su propia mutación + CAS; cada Guardar pide tu TOTP y queda auditado. */}
        <div className="flex items-start gap-3 rounded-lg border border-brand/30 bg-brand/12 p-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold text-ink">Cambios con step-up MFA</p>
            <p className="text-xs text-ink-subtle">
              Cada servicio se guarda por separado (modo, multiplicador, tarifa mínima, piso de puja
              override, activar/desactivar): cada Guardar pide tu código TOTP, valida la versión
              (optimistic-locking) y queda auditado. El piso de puja por DEFECTO vive en On-demand.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-5">
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
              <div className="grid gap-3 pt-4">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            }
          >
            {(catalog) => (
              <CatalogPanel
                catalog={catalog}
                bidFloor={bidFloorQuery.data}
                onRetryBidFloor={() => void bidFloorQuery.refetch()}
              />
            )}
          </AsyncSection>
        </div>
      </div>
    </div>
  );
}
