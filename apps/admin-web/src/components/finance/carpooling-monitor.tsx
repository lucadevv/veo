'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { formatPEN } from '@veo/utils/money';
import type { ActiveCarpoolItem, ActiveCarpoolState, ActiveCarpoolsView } from '@/lib/api/schemas';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui/states';

/**
 * MONITOREO de carpools activos (board veo.pen `20 · Carpooling` · TSqpB): la fila de KPIs + la tabla
 * "Carpools activos", encima de los Parámetros. Los 4 primeros KPIs son REALES de booking-service (ocupación =
 * reservados/totales; conteos; cupos) — CERO números inventados. El board mostraba además "Ahorro prom.
 * pasajero" (sin fuente → OMITIDO) y "Fee recaudado": el FEE específico del carpooling no tiene fuente, pero el
 * revenue TOTAL del modo CARPOOLING sí (analytics `byMode`, Σ netSettled) → se cablea como 5º KPI "Recaudado
 * carpooling" rotulado HONESTO ("total liquidado", NO el fee). Si la query de revenue no está → el KPI degrada.
 */

/**
 * Revenue del modo CARPOOLING para el 5º KPI. Discrimina los 3 estados de la query de analytics (la lleva la
 * página, separada de la de carpools activos) para que el KPI degrade honesto: cargando (skeleton), no
 * disponible (error) o el monto liquidado (Σ netSettled del rango). NO es el service-fee — es el total liquidado.
 */
export type CarpoolRevenue =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; cents: number };

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
    <li className="border-b border-border/60 last:border-b-0">
      {/* La fila entera LINKEA al detalle del carpool (`/finance/carpooling/:id`) — el chevron dejó de ser
          decorativo. Foco visible + hover del theme para la afordancia. */}
      <Link
        href={`/finance/carpooling/${carpool.id}`}
        className="flex items-center gap-4 px-5 py-3.5 outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
      >
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
      </Link>
    </li>
  );
}

/**
 * KPI del monitor con el ritmo de la card de "En vivo" (KpiGrid): label apagado + número display grande
 * (tabular, tracking apretado) y una línea de contexto opcional. Sin ícono ni tinte — ninguno de estos KPIs
 * tiene estado de alerta real, así que el tinte danger se reserva para cuando lo haya (fiel a En vivo).
 */
function KpiCard({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[18px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <p className="text-[13px] font-medium text-ink-muted">{label}</p>
      {loading ? (
        <div className="h-8 w-20 animate-pulse rounded bg-surface-2" />
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="font-display text-[34px] font-bold leading-none tracking-[-1.2px] tabular text-ink">
            {value}
          </p>
          {hint ? <p className="text-[13px] text-ink-subtle">{hint}</p> : null}
        </div>
      )}
    </div>
  );
}

/** Panel de monitoreo: KPIs + tabla "Carpools activos". `data` REAL del backend (finance/carpooling/active). */
export function CarpoolingMonitor({
  data,
  revenue,
}: {
  data: ActiveCarpoolsView;
  // Revenue del modo CARPOOLING (analytics `byMode`) para el 5º KPI. Query aparte (la lleva la página): degrada
  // sola sin tumbar el resto del monitor.
  revenue: CarpoolRevenue;
}) {
  const { stats, carpools } = data;
  const seatsTotal = stats.seatsReserved + stats.seatsAvailable;
  return (
    <div className="space-y-5">
      {/* 5 KPIs: los 4 primeros de booking-service (cero inventados) + "Recaudado carpooling" (analytics byMode,
          Σ netSettled = total liquidado, NO el fee). La fila cascadea (stagger) y pasa a 5 columnas en desktop. */}
      <div className="stagger grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Carpools activos" value={String(stats.activeCount)} />
        <KpiCard
          label="Asientos ocupados"
          value={`${stats.avgOccupancyPct}%`}
          hint={seatsTotal > 0 ? `${stats.seatsReserved} de ${seatsTotal} asientos` : undefined}
        />
        <KpiCard label="Cupos disponibles" value={String(stats.seatsAvailable)} />
        <KpiCard label="En ruta ahora" value={String(stats.enRouteCount)} />
        {/* Recaudado carpooling: total LIQUIDADO del modo (Σ netSettled, últimos 30d), rótulo HONESTO — NO es el
            service-fee (ese no tiene fuente). Degrada honesto: cargando (skeleton) / no disponible (error). */}
        <KpiCard
          label="Recaudado carpooling"
          value={
            revenue.status === 'ready'
              ? formatPEN(revenue.cents)
              : revenue.status === 'error'
                ? '—'
                : ''
          }
          loading={revenue.status === 'loading'}
          hint={revenue.status === 'error' ? 'No disponible' : 'Total liquidado · 30d'}
        />
      </div>

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
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="rounded-[18px] border border-black/[0.05] bg-surface p-[22px] shadow-3"
          >
            <div className="h-3 w-24 animate-pulse rounded bg-surface-2" />
            <div className="mt-4 h-8 w-16 animate-pulse rounded bg-surface-2" />
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
