'use client';

import { useOverview } from '@/lib/api/queries';
import { PageHeader } from '@/components/layout/page-header';
import { OverviewChart } from '@/components/charts/overview-chart';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';

/**
 * Métricas · analítica temporal (tendencias de las últimas horas). Separada de "En vivo" (/ops),
 * que es operación instantánea (mapa + estado actual). Acá vive lo histórico: viajes y recaudación
 * por intervalo, con espacio para crecer (más KPIs/filtros). Mismo `useOverview` que alimenta los KPIs.
 */
export default function MetricsPage() {
  const overview = useOverview();

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Métricas"
        description="Tendencias de operación y recaudación de las últimas horas."
      />

      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        {overview.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        ) : overview.isError ? (
          <ErrorState onRetry={() => void overview.refetch()} />
        ) : overview.data ? (
          <OverviewChart series={overview.data.series} />
        ) : null}
      </div>
    </div>
  );
}
