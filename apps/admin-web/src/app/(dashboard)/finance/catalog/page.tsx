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
import { BidFloorPanel } from '@/components/pricing/bid-floor-panel';

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
          breadcrumbs={[{ label: 'Precios' }, { label: 'Tarifas por oferta' }]}
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
        breadcrumbs={[{ label: 'Precios' }, { label: 'Tarifas por oferta' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* Aviso de step-up (mismo patrón que Precios on-demand): el catálogo y el piso de la puja son DOS
            configs con su propia mutación + CAS; cada Guardar pide tu TOTP y queda auditado. */}
        <div className="flex items-start gap-3 rounded-lg border border-brand/30 bg-brand/12 p-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold text-ink">Cambios con step-up MFA</p>
            <p className="text-xs text-ink-subtle">
              El catálogo (modo, multiplicador, tarifa mínima, activar/desactivar) y el piso de la
              puja son configs SEPARADAS: cada Guardar pide tu código TOTP, valida la versión
              (optimistic-locking) y queda auditado. No hay un guardado global.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-5">
          {/*
            Piso de la PUJA por DEFECTO (global). Los pisos POR OFERTA se editan abajo, en cada fila del
            catálogo; el default global (fallback cuando una oferta no tiene override) vive acá — su config es
            la misma (/pricing/bid-floor, mismo CAS) pero es la ÚNICA superficie que edita `defaultFloorCents`.
          */}
          <AsyncSection query={bidFloorQuery} skeleton={<Skeleton className="h-40" />}>
            {(data) => <BidFloorPanel config={data} />}
          </AsyncSection>

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
