'use client';

import { Armchair, ChevronRight, Navigation, Ticket, Users } from 'lucide-react';
import type { ActiveCarpoolItem, ActiveCarpoolState, ActiveCarpoolsView } from '@/lib/api/schemas';
import { cn } from '@/lib/cn';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/states';

/**
 * MONITOREO de carpools activos (board veo.pen `20 · Carpooling` · TSqpB): la fila de 4 KPIs + la tabla
 * "Carpools activos", encima de los Parámetros. TODO dato es REAL de booking-service (ocupación = reservados/
 * totales; conteos; cupos) — CERO números inventados. El board mostraba además "Ahorro prom. pasajero" y "Fee
 * recaudado": no tienen fuente en booking-service (la plata vive en payment/analytics), así que se sustituyen
 * por KPIs reales del dominio (cupos disponibles, en ruta ahora) en vez de mostrar un número falso.
 */

/** Estado de la oferta → chip (label + tono del theme). Fiel al board: publicado=brand, lleno=warn, en curso=success. */
const STATUS_CHIP: Record<ActiveCarpoolState, { label: string; className: string }> = {
  PUBLICADO: { label: 'Publicado', className: 'bg-brand/12 text-brand' },
  PARCIALMENTE_RESERVADO: { label: 'Publicado', className: 'bg-brand/12 text-brand' },
  LLENO: { label: 'Completo', className: 'bg-warn/[0.12] text-warn' },
  EN_RUTA: { label: 'En curso', className: 'bg-success/[0.12] text-success' },
};

/** Tope de puntos de ocupación dibujados (evita overflow si un viaje tuviera muchos asientos); el número es exacto. */
const MAX_SEAT_DOTS = 8;

const departureFmt = new Intl.DateTimeFormat('es-PE', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Ruta como coords públicas origen→destino: booking-service guarda lat/lon + H3, no nombres de distrito. */
function routeLabel(c: ActiveCarpoolItem): string {
  const pt = (lat: number, lon: number) => `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  return `${pt(c.origenLat, c.origenLon)} → ${pt(c.destinoLat, c.destinoLon)}`;
}

/** Fila de un carpool activo: ruta + conductor·salida · puntos de ocupación · chip de estado. */
function CarpoolRow({ carpool }: { carpool: ActiveCarpoolItem }) {
  const chip = STATUS_CHIP[carpool.estado];
  const dots = Math.min(carpool.asientosTotales, MAX_SEAT_DOTS);
  const salida = departureFmt.format(new Date(carpool.fechaHoraSalida));
  return (
    <li className="flex items-center gap-4 border-b border-border/60 px-5 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-ink">{routeLabel(carpool)}</span>
        <span className="truncate text-xs text-ink-muted">
          {carpool.driverName ?? 'Conductor'} · sale {salida}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5" aria-hidden>
        {Array.from({ length: dots }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'size-3 rounded-full',
              i < carpool.asientosReservados ? 'bg-brand' : 'bg-surface-2',
            )}
          />
        ))}
        <span className="ml-1 font-mono text-xs font-semibold text-ink-muted tabular">
          {carpool.asientosReservados}/{carpool.asientosTotales}
        </span>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold',
          chip.className,
        )}
      >
        {chip.label}
      </span>
      <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden />
    </li>
  );
}

/** Panel de monitoreo: KPIs (StatCard) + tabla "Carpools activos". `data` REAL del backend (finance/carpooling/active). */
export function CarpoolingMonitor({ data }: { data: ActiveCarpoolsView }) {
  const { stats, carpools } = data;
  const seatsTotal = stats.seatsReserved + stats.seatsAvailable;
  return (
    <div className="space-y-5">
      {/* 4 KPIs — todos derivados de datos reales de booking-service (cero inventados). */}
      <StatCardGrid>
        <StatCard icon={Users} label="Carpools activos" value={String(stats.activeCount)} />
        <StatCard
          icon={Armchair}
          label="Asientos ocupados"
          value={`${stats.avgOccupancyPct}%`}
          iconTone="success"
          hint={seatsTotal > 0 ? `${stats.seatsReserved} de ${seatsTotal} asientos` : undefined}
        />
        <StatCard
          icon={Ticket}
          label="Cupos disponibles"
          value={String(stats.seatsAvailable)}
          iconTone="brand"
        />
        <StatCard
          icon={Navigation}
          label="En ruta ahora"
          value={String(stats.enRouteCount)}
          iconTone="brand"
        />
      </StatCardGrid>

      {/* Tabla "Carpools activos" (board TSqpB · Left). */}
      <section className="overflow-hidden rounded-[18px] border border-black/[0.05] bg-surface shadow-3">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-baseline gap-2.5">
            <h2 className="font-display text-base font-bold text-ink">Carpools activos</h2>
            <span className="text-xs text-ink-muted">
              {carpools.length} {carpools.length === 1 ? 'listado' : 'listados'}
            </span>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-success/[0.12] px-2.5 py-1 text-xs font-semibold text-success">
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            En vivo
          </span>
        </header>
        {carpools.length === 0 ? (
          <EmptyState
            title="Sin carpools activos"
            description="No hay viajes compartidos publicados o en curso ahora mismo."
          />
        ) : (
          <ul>
            {carpools.map((c) => (
              <CarpoolRow key={c.id} carpool={c} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Skeleton del monitoreo (loading): 4 stat placeholders + la tabla. Mismas alturas → sin layout shift. */
export function CarpoolingMonitorSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Cargando monitoreo de carpooling">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-surface px-4 py-3.5"
          >
            <div className="h-3 w-24 animate-pulse rounded bg-surface-2" />
            <div className="mt-2 h-9 w-16 animate-pulse rounded bg-surface-2" />
          </div>
        ))}
      </div>
      <div className="rounded-[18px] border border-black/[0.05] bg-surface p-5 shadow-3">
        <div className="h-5 w-40 animate-pulse rounded bg-surface-2" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-surface-2" />
          ))}
        </div>
      </div>
    </div>
  );
}
