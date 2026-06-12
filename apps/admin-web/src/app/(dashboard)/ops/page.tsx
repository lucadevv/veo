'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useOverview, useTrips } from '@/lib/api/queries';
import { useOpsStore } from '@/lib/realtime/ops-store';
import { money, relativeFromNow } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { KpiGrid } from '@/components/ops/kpi-grid';
import { OverviewChart } from '@/components/charts/overview-chart';
import { TripStatusBadge, isActiveTrip } from '@/components/trips/status-badge';
import { MapView, type MapMarker } from '@/components/map/lazy-map';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';

export default function OpsPage() {
  const router = useRouter();
  const drivers = useOpsStore((s) => s.drivers);
  const panics = useOpsStore((s) => s.panics);
  const overview = useOverview();
  const trips = useTrips({ status: 'ALL' });

  const markers = useMemo<MapMarker[]>(() => {
    const driverMarkers: MapMarker[] = Object.values(drivers).map((d) => ({
      id: `driver-${d.driverId}`,
      lon: d.point.lon,
      lat: d.point.lat,
      kind: 'driver',
      label: `Conductor ${d.driverId.slice(0, 8)}`,
      heading: d.heading,
    }));
    const panicMarkers: MapMarker[] = panics.map((p) => ({
      id: `panic-${p.panicId}`,
      lon: p.geo.lon,
      lat: p.geo.lat,
      kind: 'panic',
      label: `Pánico ${p.tripId.slice(0, 8)}`,
    }));
    return [...driverMarkers, ...panicMarkers];
  }, [drivers, panics]);

  const tripItems = trips.data?.pages.flatMap((p) => p.items) ?? [];
  const activeTrips = tripItems.filter((t) => isActiveTrip(t.status));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Operación en vivo"
        description="Conductores, viajes y alertas en tiempo real."
      />

      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_400px]">
        <div className="relative min-h-[320px] border-b border-border lg:border-b-0">
          <MapView markers={markers} onMarkerClick={(id) => {
            const panic = panics.find((p) => `panic-${p.panicId}` === id);
            if (panic) router.push(`/security/panics/${panic.panicId}`);
          }} />
        </div>

        <aside className="flex min-h-0 flex-col overflow-y-auto border-t border-border bg-bg p-4 lg:border-l lg:border-t-0">
          <section aria-label="Indicadores">
            {overview.isLoading ? (
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-20" />
                ))}
              </div>
            ) : overview.isError ? (
              <ErrorState onRetry={() => void overview.refetch()} />
            ) : overview.data ? (
              <KpiGrid data={overview.data} />
            ) : null}
          </section>

          <section aria-label="Viajes activos" className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Viajes activos</h2>
              <Link href="/ops/trips" className="text-xs font-medium text-accent hover:underline">
                Ver todos
              </Link>
            </div>
            {trips.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            ) : trips.isError ? (
              <ErrorState onRetry={() => void trips.refetch()} />
            ) : activeTrips.length === 0 ? (
              <EmptyState title="Sin viajes activos" description="No hay viajes en curso ahora." />
            ) : (
              <ul className="space-y-2">
                {activeTrips.map((t) => (
                  <li key={t.id}>
                    <Link href={`/ops/trips/${t.id}`}>
                      <Card className="px-3 py-2.5 transition-colors hover:bg-surface-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-xs text-ink-muted">
                            {t.id.slice(0, 8)}
                          </span>
                          <TripStatusBadge status={t.status} />
                        </div>
                        <div className="mt-1 flex items-center justify-between text-xs">
                          <span className="text-ink-muted">{relativeFromNow(t.createdAt)}</span>
                          <span className="font-medium text-ink tabular">{money(t.fareCents)}</span>
                        </div>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      <section aria-label="Tendencias" className="border-t border-border p-4 lg:p-6">
        {overview.data ? <OverviewChart series={overview.data.series} /> : null}
      </section>
    </div>
  );
}
