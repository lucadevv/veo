'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight, Download, Search } from 'lucide-react';
import { useTrips, type TripFilters } from '@/lib/api/queries';
import { normalizeTripStatus } from '@/lib/api/schemas';
import type { AdminTripStatus, TripStatus, TripUpdateMsg } from '@/lib/api/schemas';
import { useOpsStore } from '@/lib/realtime/ops-store';
import { money } from '@/lib/formatters';
import { FILTER_ALL } from '@/lib/filters';
import { AdminTopbar } from '@/components/layout/admin-topbar';
import { ConnectionStatus } from '@/components/ops/connection-status';
import { LoadMore } from '@/components/ui/load-more';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { useRequestAccess } from '@/lib/use-request-access';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { TripStatusBadge, isActiveTrip } from '@/components/trips/status-badge';
import { TripModePill } from '@/components/trips/mode-pill';

/** Estados FILTRABLES por el backend (subset del DTO ListTripsQueryDto — no todos los estados se pueden filtrar). */
const STATUS_OPTIONS: { value: TripStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'Todos los estados' },
  { value: 'IN_PROGRESS', label: 'En curso' },
  { value: 'ARRIVING', label: 'En camino' },
  { value: 'REQUESTED', label: 'Solicitado' },
  { value: 'MATCHING', label: 'Buscando' },
  { value: 'COMPLETED', label: 'Completado' },
  { value: 'CANCELLED', label: 'Cancelado' },
];

/**
 * Overlay del estado VIVO (`trip:update` del ops-socket) sobre el row del REST (poll de 15s).
 * Reglas de no-mentira:
 *  - REST terminal es autoritativo y FINAL: el socket deja de emitir al cerrar el viaje — un msg
 *    viejo del store no debe "revivir" un viaje ya terminado.
 *  - status del socket fuera del contrato (drift de versión) → NO pisar el REST (normalize = null).
 */
function overlayLiveStatus(rest: AdminTripStatus, live: TripUpdateMsg | undefined): AdminTripStatus {
  if (!live || !isActiveTrip(rest)) return rest;
  return normalizeTripStatus(live.status) ?? rest;
}

/** Iniciales (2) de un nombre para el avatar. Sin nombre → "•". */
function initials(name: string | null): string {
  if (!name) return '•';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '•';
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
}

export default function TripsPage() {
  return (
    <Suspense fallback={<div className="p-7 text-sm text-ink-muted">Cargando…</div>}>
      <TripsInner />
    </Suspense>
  );
}

function TripsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const user = useSession();
  const requestAccess = useRequestAccess();
  const [search, setSearch] = useState('');
  // Updates en vivo del ops-socket: el badge de estado se adelanta al próximo poll del REST.
  const liveTrips = useOpsStore((s) => s.trips);

  const filters = useMemo<TripFilters>(
    () => ({ status: (params.get('status') as TripStatus | 'ALL' | null) ?? 'ALL' }),
    [params],
  );

  const setStatus = useCallback(
    (value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value && value !== FILTER_ALL) next.set('status', value);
      else next.delete('status');
      router.replace(`/ops/trips?${next.toString()}`);
    },
    [params, router],
  );

  const query = useTrips(filters);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  // Búsqueda CLIENT-SIDE sobre lo ya cargado (id / pasajero / conductor). Honesta: el backend no tiene
  // full-text (índice Redis por estado) → filtra las páginas cargadas, no todo el historial.
  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          (t.passengerName ?? '').toLowerCase().includes(q) ||
          (t.driverName ?? '').toLowerCase().includes(q),
      )
    : rows;

  function onExport() {
    const header = ['id', 'estado', 'pasajero', 'conductor', 'tarifa_cents', 'creado'];
    const csv = [
      header,
      ...filtered.map((t) => [
        t.id,
        t.status,
        t.passengerName ?? t.passengerId,
        t.driverName ?? t.driverId ?? '',
        String(t.fareCents),
        t.createdAt,
      ]),
    ]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'veo-viajes.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const topbar = (
    <AdminTopbar title="Viajes" actions={<ConnectionStatus />} />
  );

  if (!can(user, 'trips:view')) {
    return (
      <div className="flex h-full flex-col">
        {topbar}
        <PermissionState
          className="flex-1"
          section="Viajes"
          permission="trips:view"
          onRequest={() => requestAccess('trips:view')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {topbar}

      <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto p-7">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-black/[0.05] bg-surface p-3.5 shadow-3">
          <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-[10px] border border-border bg-bg px-3 py-2">
            <Search className="size-[17px] shrink-0 text-ink-subtle" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar viaje, pasajero o conductor…"
              aria-label="Buscar viajes cargados"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
            />
          </div>
          <select
            value={filters.status ?? 'ALL'}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filtrar por estado"
            className="rounded-[11px] border border-border bg-bg px-3 py-[9px] text-sm font-medium text-ink outline-none"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onExport}
            disabled={filtered.length === 0}
            className="flex items-center gap-2 rounded-[11px] bg-accent px-4 py-[9px] text-sm font-semibold text-accent-on shadow-brand transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            <Download className="size-4" aria-hidden />
            Exportar
          </button>
        </div>

        {/* Tabla */}
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-black/[0.05] bg-surface shadow-3">
            {/* Header */}
            <div className="flex items-center gap-4 border-b border-[color:var(--divider)] bg-bg px-[22px] py-3 font-display text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
              <span className="w-[130px] shrink-0">Viaje</span>
              <span className="flex-1">Pasajero</span>
              <span className="hidden w-[180px] shrink-0 lg:block">Conductor</span>
              <span className="hidden w-[110px] shrink-0 md:block">Modo</span>
              <span className="w-[90px] shrink-0">Precio</span>
              <span className="w-[120px] shrink-0">Estado</span>
              <span className="w-6 shrink-0" />
            </div>

            {query.isLoading ? (
              <div className="space-y-px p-3">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                title="Sin viajes"
                description={q ? 'Ningún viaje cargado coincide con la búsqueda.' : 'No hay viajes que coincidan con el filtro.'}
              />
            ) : (
              <ul className="stagger">
                {filtered.map((t, i) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => router.push(`/ops/trips/${t.id}`)}
                      aria-label={`Ver detalle del viaje ${t.id.slice(0, 8)}`}
                      className={cnRow(i, filtered.length)}
                    >
                      <span className="flex w-[130px] shrink-0 flex-col items-start gap-0.5">
                        <span className="font-mono text-[13px] font-medium text-ink">
                          #{t.id.slice(0, 8)}
                        </span>
                        <span className="text-xs text-ink-subtle">{hhmm(t.createdAt)}</span>
                      </span>

                      <span className="flex min-w-0 flex-1 items-center gap-2.5">
                        <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent">
                          {initials(t.passengerName)}
                        </span>
                        <span className="truncate text-sm text-ink">
                          {t.passengerName ?? (
                            <span className="font-mono text-xs text-ink-muted">
                              {t.passengerId.slice(0, 8)}
                            </span>
                          )}
                        </span>
                      </span>

                      <span className="hidden w-[180px] shrink-0 truncate text-[13px] lg:block">
                        {t.driverName ? (
                          <span className="text-ink">{t.driverName}</span>
                        ) : (
                          <span className="text-ink-subtle">Sin asignar</span>
                        )}
                      </span>

                      {/* MODO: enriquecido on-read desde trip-service (dispatchMode CONGELADO). null → "—" honesto. */}
                      <span className="hidden w-[110px] shrink-0 md:block">
                        <TripModePill mode={t.dispatchMode} />
                      </span>

                      <span className="w-[90px] shrink-0 font-mono text-[13px] font-medium text-ink tabular">
                        {money(t.fareCents)}
                      </span>

                      <span className="w-[120px] shrink-0">
                        <TripStatusBadge status={overlayLiveStatus(t.status, liveTrips[t.id])} />
                      </span>

                      <ChevronRight className="size-[17px] shrink-0 text-ink-subtle" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Paginación cursor (el backend no da total → "Cargar más", no números de página) */}
        {!query.isLoading && filtered.length > 0 ? (
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink-muted">
              Mostrando {filtered.length} viaje{filtered.length === 1 ? '' : 's'} cargado
              {filtered.length === 1 ? '' : 's'}
            </span>
            <LoadMore
              hasNextPage={!!query.hasNextPage}
              isFetching={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Clase de fila: layout + hover + borde inferior salvo la última. */
function cnRow(i: number, total: number): string {
  const base =
    'flex w-full items-center gap-4 px-[22px] py-3.5 text-left transition-colors hover:bg-surface-2';
  return i < total - 1 ? `${base} border-b border-[color:var(--divider)]` : base;
}
