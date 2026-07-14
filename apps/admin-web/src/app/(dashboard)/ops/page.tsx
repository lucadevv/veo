'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, RefreshCw, Radio, WifiOff } from 'lucide-react';
import { useOverview } from '@/lib/api/queries';
import { useOpsStore } from '@/lib/realtime/ops-store';
import { number } from '@/lib/formatters';
import { AdminTopbar } from '@/components/layout/admin-topbar';
import { ConnectionStatus } from '@/components/ops/connection-status';
import { KpiGrid } from '@/components/ops/kpi-grid';
import { DriverPopover } from '@/components/ops/driver-popover';
import { PanicsRecent } from '@/components/ops/panics-recent';
import { HourlyBars } from '@/components/ops/hourly-bars';
import { ServiceModesDonut } from '@/components/ops/service-modes-donut';
import { MapView, type MapMarker } from '@/components/map/lazy-map';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, PermissionState } from '@/components/ui/states';
import { useRequestAccess } from '@/lib/use-request-access';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';

// Leyenda HONESTA: solo lo que el mapa dibuja (markers de conductor en accent + pánico en danger —
// mismos colores que PIN_VAR del MapView). No prometer capas que no existen (pasajeros/rutas).
const LEGEND = [
  { label: 'Conductores', className: 'bg-accent' },
  { label: 'Pánicos', className: 'bg-danger' },
] as const;

export default function OpsPage() {
  const router = useRouter();
  const user = useSession();
  const requestAccess = useRequestAccess();
  const drivers = useOpsStore((s) => s.drivers);
  const panics = useOpsStore((s) => s.panics);
  const status = useOpsStore((s) => s.status);
  const overview = useOverview();
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  // El stream en vivo perdió conexión (server cerró o red caída). 'reconnecting' = reintentando con backoff.
  const socketDown = status === 'disconnected' || status === 'reconnecting';

  const markers = useMemo<MapMarker[]>(() => {
    const driverMarkers: MapMarker[] = Object.values(drivers).map(({ msg: d }) => ({
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

  const topbar = (
    <AdminTopbar
      title="En vivo"
      subtitle="Operación en tiempo real · Lima Metropolitana"
      actions={
        <>
          <ConnectionStatus />
          <span className="hidden items-center gap-2 rounded-[10px] border border-border bg-surface px-3.5 py-2 text-[13px] font-medium text-ink sm:flex">
            <CalendarDays className="size-[15px] text-ink-subtle" aria-hidden />
            Últimas 24 h
          </span>
        </>
      }
    />
  );

  if (!can(user, 'ops:view')) {
    return (
      <div className="flex h-full flex-col">
        {topbar}
        <PermissionState
          className="flex-1"
          section="En vivo"
          permission="ops:view"
          onRequest={() => requestAccess('ops:view')}
        />
      </div>
    );
  }

  const stat = overview.data
    ? `${number(overview.data.activeTrips)} en curso · ${number(overview.data.onlineDrivers)} en línea`
    : null;

  return (
    <div className="flex h-full flex-col">
      {topbar}

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-7">
        {/* KPIs */}
        <section aria-label="Indicadores">
          {overview.isLoading ? (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-[104px] rounded-[18px]" />
              ))}
            </div>
          ) : overview.isError ? (
            <ErrorState onRetry={() => void overview.refetch()} />
          ) : overview.data ? (
            <KpiGrid data={overview.data} />
          ) : null}
        </section>

        {/* Mapa + pánicos recientes */}
        <div className="flex flex-col gap-5 lg:h-[430px] lg:flex-row">
          <div className="relative h-[320px] overflow-hidden rounded-xl border border-black/[0.05] shadow-3 lg:h-full lg:flex-1">
            <MapView
              markers={markers}
              onMarkerClick={(id) => {
                const panic = panics.find((p) => `panic-${p.panicId}` === id);
                if (panic) {
                  router.push(`/security/panics/${panic.panicId}`);
                  return;
                }
                // Marker de conductor (`driver-<id>`) → card flotante del conductor.
                if (id.startsWith('driver-')) setSelectedDriverId(id.slice('driver-'.length));
              }}
            />
            {selectedDriverId ? (
              <DriverPopover
                driverId={selectedDriverId}
                onClose={() => setSelectedDriverId(null)}
              />
            ) : null}

            {/* Estado socket-caído (JCiBD): overlay prominente sobre el mapa. El stream auto-reintenta con
                backoff; "Reconectar" fuerza un re-handshake recargando (último recurso). Prioriza sobre el vacío. */}
            {socketDown ? (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-surface/75 text-center backdrop-blur-[2px]">
                <span className="grid size-12 place-items-center rounded-full bg-danger/10 text-danger">
                  <WifiOff className="size-6" aria-hidden />
                </span>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-ink">Se perdió la conexión en vivo</p>
                  <p className="text-[13px] text-ink-muted">
                    {status === 'reconnecting'
                      ? 'El stream se cortó. Reconectando…'
                      : 'El stream del ops-socket se cerró.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="flex items-center gap-2 rounded-control bg-danger px-4 py-2.5 text-[13px] font-semibold text-danger-on transition-colors hover:bg-danger-hover"
                >
                  <RefreshCw className="size-4" aria-hidden />
                  Reconectar
                </button>
              </div>
            ) : markers.length === 0 ? (
              /* Estado sin-actividad (SJOIJ): sin conductores ni pánicos en vivo. El mapa se alimenta del socket
                 (se actualiza solo); "Actualizar" refresca los KPIs de contexto. */
              <div className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-3 text-center">
                <span className="grid size-12 place-items-center rounded-full bg-surface text-ink-subtle shadow-2">
                  <Radio className="size-6" aria-hidden />
                </span>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-ink">Sin actividad ahora</p>
                  <p className="text-[13px] text-ink-muted">
                    No hay viajes ni conductores activos en este momento.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void overview.refetch()}
                  className="pointer-events-auto flex items-center gap-2 rounded-control border border-border bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink shadow-1 transition-colors hover:bg-surface-2"
                >
                  <RefreshCw className="size-4 text-ink-muted" aria-hidden />
                  Actualizar
                </button>
              </div>
            ) : null}
            {/* Overlays fieles al diseño (datos reales) */}
            {stat ? (
              <div className="absolute left-4 top-4 rounded-[10px] bg-[#0A0B0F]/80 px-3 py-2 text-xs font-medium text-white shadow-2">
                {stat}
              </div>
            ) : null}
            <div className="absolute bottom-4 left-4 flex items-center gap-4 rounded-[10px] border border-border bg-surface px-3.5 py-2 shadow-2">
              {LEGEND.map((l) => (
                <span key={l.label} className="flex items-center gap-2 text-xs font-medium text-ink-muted">
                  <span className={`size-[9px] rounded-full ${l.className}`} aria-hidden />
                  {l.label}
                </span>
              ))}
            </div>
          </div>

          <div className="lg:h-full lg:w-[440px]">
            <PanicsRecent />
          </div>
        </div>

        {/* Charts */}
        <div className="stagger flex flex-col gap-5 xl:flex-row">
          <HourlyBars series={overview.data?.series ?? []} />
          <ServiceModesDonut byMode={overview.data?.byMode ?? []} />
        </div>
      </div>
    </div>
  );
}
