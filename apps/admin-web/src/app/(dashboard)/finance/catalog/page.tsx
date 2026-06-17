'use client';

import { Lock } from 'lucide-react';
import { useCatalog } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { CatalogPanel } from '@/components/catalog/catalog-panel';

/**
 * Catálogo de ofertas (ADR 013 · Fase B). Vive bajo Finanzas: la disponibilidad de servicios es decisión
 * comercial/operativa. Gate de presentación con `catalog:view`; el admin-bff (RolesGuard) y trip-service
 * re-autorizan server-side. El pasajero ve y cotiza solo lo habilitado acá (server-driven, sin release).
 */
export default function CatalogPage() {
  const user = useSession();
  const query = useCatalog();

  if (!can(user, 'catalog:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Catálogo de ofertas" breadcrumbs={[{ label: 'Finanzas' }, { label: 'Catálogo' }]} />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver el catálogo de ofertas."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Catálogo de ofertas"
        description="Activá o desactivá cada servicio (VEO Moto, Económico, Confort, XL). El pasajero ve solo lo habilitado."
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Catálogo' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.isLoading || !query.data ? (
          <div className="grid gap-3 pt-4">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : (
          <CatalogPanel catalog={query.data} />
        )}
      </div>
    </div>
  );
}
