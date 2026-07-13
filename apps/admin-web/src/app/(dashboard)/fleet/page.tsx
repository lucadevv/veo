'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Ban,
  Bike,
  Car,
  ChevronRight,
  CircleCheck,
  CalendarClock,
  Download,
  FileClock,
  Search,
} from 'lucide-react';
import { useVehicles, useVehiclesSummary } from '@/lib/api/queries';
import type { VehicleView } from '@/lib/api/schemas';
import { downloadCsv } from '@/lib/csv';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useRequestAccess } from '@/lib/use-request-access';
import { StatCard } from '@/components/ui/stat-card';
import { DotPill, type PillTone } from '@/components/ui/dot-pill';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';

/** Días entre hoy y una fecha ISO (para "Vence N días"). null si no hay fecha. */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86_400_000);
}

const DocStatus = { VALID: 'VALID', EXPIRING_SOON: 'EXPIRING_SOON', EXPIRED: 'EXPIRED' } as const;

/**
 * Estado DERIVADO del vehículo (suspensión = función de docs+ITV, no un flag stored):
 *  - Suspendido: hay un problema REAL de vigencia — documento vencido (docStatus EXPIRED) o ITV corrida y vencida.
 *  - En revisión: le falta completar para operar (no operable = sin ficha/docs, sin ITV aún, o docs por vencer).
 *    OJO: `!operable` NO es suspensión — un vehículo nuevo sin docs cargados está EN REVISIÓN, no suspendido.
 *  - Activo: operable, docs vigentes e ITV vigente.
 * Alinea la columna Estado con lo que la cola de Revisiones llama "revisión de aptitud" (no "suspendido").
 */
function estado(v: VehicleView): {
  key: 'activo' | 'enRevision' | 'suspendido';
  label: string;
  tone: PillTone;
} {
  if (v.status === DocStatus.EXPIRED || (v.itvHasInspection && !v.itvCurrent))
    return { key: 'suspendido', label: 'Suspendido', tone: 'danger' };
  if (!v.operable || !v.itvHasInspection || v.status === DocStatus.EXPIRING_SOON)
    return { key: 'enRevision', label: 'En revisión', tone: 'warn' };
  return { key: 'activo', label: 'Activo', tone: 'success' };
}

/** ¿La ITV vigente vence dentro de la ventana (30 días)? Para la card + tab "ITV por vencer". */
function itvExpiringSoon(v: VehicleView): boolean {
  const d = daysUntil(v.itvNextDueAt);
  return v.itvCurrent && d !== null && d >= 0 && d <= 30;
}

/**
 * Pill de DOCUMENTOS: refleja el estado REAL de los documentos, no solo el agregado `docStatus`.
 * COHERENCIA con la columna ESTADO (que deriva de `operable`): el agregado `docStatus` puede quedar en VALID
 * mientras los documentos individuales (SOAT/ITV) están PENDING_REVIEW o faltan — la operabilidad real lo sabe
 * (`operabilityReason === 'DOCS'`). Sin esto la fila mostraba "Completos" junto a "En revisión" (dos fuentes
 * que se contradicen). Vencido/por-vencer siguen mandando (son estados del propio docStatus).
 */
function docsPill(v: VehicleView): { tone: PillTone; label: string } {
  if (v.status === DocStatus.EXPIRED) return { tone: 'danger', label: 'Vencidos' };
  if (v.status === DocStatus.EXPIRING_SOON) return { tone: 'warn', label: 'Por vencer' };
  if (!v.operable && v.operabilityReason === 'DOCS') return { tone: 'warn', label: 'Pendientes' };
  if (v.status === DocStatus.VALID) return { tone: 'success', label: 'Completos' };
  return { tone: 'neutral', label: v.status };
}

/** Pill de ITV (última inspección). */
function itvPill(v: VehicleView): { tone: PillTone; label: string } {
  if (!v.itvHasInspection) return { tone: 'neutral', label: 'Sin ITV' };
  if (!v.itvCurrent) return { tone: 'danger', label: 'Vencida' };
  const d = daysUntil(v.itvNextDueAt);
  if (d !== null && d <= 30) return { tone: 'warn', label: `Vence ${d} día${d === 1 ? '' : 's'}` };
  return { tone: 'success', label: 'Vigente' };
}

type Tab = 'todos' | 'enRevision' | 'activos' | 'itvPorVencer' | 'suspendidos';
const TABS: { key: Tab; label: string }[] = [
  { key: 'todos', label: 'Todos' },
  { key: 'enRevision', label: 'En revisión' },
  { key: 'activos', label: 'Activos' },
  { key: 'itvPorVencer', label: 'ITV por vencer' },
  { key: 'suspendidos', label: 'Suspendidos' },
];

const GRID = 'grid grid-cols-[1fr_90px_170px_130px_130px_120px_24px] items-center gap-4';

export default function VehiclesPage() {
  const router = useRouter();
  const user = useSession();
  const requestAccess = useRequestAccess();
  const [tab, setTab] = useState<Tab>('todos');
  const [search, setSearch] = useState('');

  const vehicles = useVehicles();
  // Resumen AUTORITATIVO por estado documental (server-side, sobre TODA la flota) — las otras cards derivan del
  // set paginado ya cargado en el cliente; esta card muestra el conteo REAL de documentos próximos a vencer.
  const vehiclesSummary = useVehiclesSummary();

  // Todos los vehículos cargados. Cards + tab-counts + filas derivan de ESTE set con el MISMO estado() → la
  // columna Estado, las cards y los badges de tab SIEMPRE coinciden (antes las cards usaban docStatus del BFF y
  // la fila usaba `operable` → se contradecían: "Activos 2" con las 2 filas en "Suspendido").
  const all = useMemo<VehicleView[]>(
    () => vehicles.data?.pages.flatMap((p) => p.items) ?? [],
    [vehicles.data],
  );

  // Total AUTORITATIVO de la flota (server · /ops/vehicles/summary, sobre TODA la flota) = suma de los buckets
  // documentales. El `all.length` derivado solo cuenta las PÁGINAS ya cargadas → subcuenta hasta "Cargar más".
  // OJO: las cards Activos/ITV/Suspendidos son OTRO eje (operable + ITV vigente) que DEBE coincidir con las filas
  // visibles → se dejan derivadas del set cargado; mapearlas a los buckets doc del summary contradiría la columna
  // Estado (un vehículo doc-VALID con ITV vencida es "Suspendido" en la fila, no "Activo").
  const vs = vehiclesSummary.data;
  const fleetTotal = vs ? vs.valid + vs.expiringSoon + vs.expired : all.length;

  const matchesTab = (v: VehicleView, t: Tab): boolean => {
    if (t === 'todos') return true;
    if (t === 'itvPorVencer') return itvExpiringSoon(v);
    const st = estado(v).key;
    return (
      (t === 'activos' && st === 'activo') ||
      (t === 'enRevision' && st === 'enRevision') ||
      (t === 'suspendidos' && st === 'suspendido')
    );
  };

  const rows = useMemo<VehicleView[]>(() => {
    const byTab = all.filter((v) => matchesTab(v, tab));
    const q = search.trim().toLowerCase();
    return q
      ? byTab.filter(
          (v) =>
            v.plate.toLowerCase().includes(q) ||
            (v.driverName ?? '').toLowerCase().includes(q) ||
            `${v.brand} ${v.model}`.toLowerCase().includes(q),
        )
      : byTab;
  }, [all, tab, search]);

  const cards = useMemo(
    () => ({
      total: all.length,
      activos: all.filter((v) => estado(v).key === 'activo').length,
      itvPorVencer: all.filter(itvExpiringSoon).length,
      suspendidos: all.filter((v) => estado(v).key === 'suspendido').length,
    }),
    [all],
  );

  const tabCount = (t: Tab): number => all.filter((v) => matchesTab(v, t)).length;

  const exportCsv = () =>
    downloadCsv(
      'veo-vehiculos.csv',
      ['Placa', 'Marca', 'Modelo', 'Año', 'Tipo', 'Conductor', 'Documentos', 'ITV', 'Estado'],
      rows.map((v) => [
        v.plate,
        v.brand,
        v.model,
        v.year,
        v.vehicleType === 'MOTO' ? 'Moto' : 'Auto',
        v.driverName ?? '',
        docsPill(v).label,
        itvPill(v).label,
        estado(v).label,
      ]),
    );

  if (!can(user, 'fleet:view')) {
    return (
      <PermissionState
        className="min-h-full"
        section="Vehículos"
        permission="fleet:view"
        onRequest={() => requestAccess('fleet:view')}
      />
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-[22px] px-8 py-7">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Vehículos</h1>
          {fleetTotal > 0 ? (
            <p className="text-[13px] text-ink-subtle">
              {`${fleetTotal} ${fleetTotal === 1 ? 'vehículo' : 'vehículos'} · ${tabCount('enRevision')} en revisión`}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface px-[18px] py-[11px] text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          <Download className="size-4" aria-hidden />
          Exportar
        </button>
      </div>

      {/* Stat cards — las 4 primeras derivan del MISMO estado() que las filas (suspensión = función de docs+ITV);
          "Docs por vencer" es AUTORITATIVA (server: /ops/vehicles/summary), sobre toda la flota, no el set cargado. */}
      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard
          icon={Car}
          label="Total en flota"
          value={String(fleetTotal)}
          loading={vehiclesSummary.isLoading}
        />
        <StatCard
          icon={CircleCheck}
          label="Activos"
          value={String(cards.activos)}
          iconTone="success"
          loading={vehicles.isLoading}
        />
        <StatCard
          icon={CalendarClock}
          label="ITV por vencer"
          value={String(cards.itvPorVencer)}
          iconTone="warn"
          loading={vehicles.isLoading}
        />
        <StatCard
          icon={Ban}
          label="Suspendidos"
          value={String(cards.suspendidos)}
          iconTone="danger"
          loading={vehicles.isLoading}
        />
        <StatCard
          icon={FileClock}
          label="Docs por vencer"
          value={vehiclesSummary.data ? String(vehiclesSummary.data.expiringSoon) : '—'}
          iconTone="warn"
          loading={vehiclesSummary.isLoading}
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4">
        <div className="inline-flex gap-[3px] rounded-md border border-border bg-surface p-1">
          {TABS.map(({ key, label }) => {
            const active = tab === key;
            const n = tabCount(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-[7px] text-[13px] font-semibold transition-colors ${
                  active ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {label}
                <span
                  className={`inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 font-mono text-[11px] font-bold ${
                    active ? 'bg-accent text-white' : 'bg-surface-2 text-ink-subtle'
                  }`}
                >
                  {n}
                </span>
              </button>
            );
          })}
        </div>
        <div className="inline-flex w-[280px] items-center gap-2 rounded-sm border border-border bg-bg px-3 py-[9px]">
          <Search className="size-4 shrink-0 text-ink-subtle" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar placa, conductor o modelo…"
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle"
          />
        </div>
      </div>

      {/* Tabla */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div
          className={`${GRID} border-b border-border bg-surface-2 px-5 py-3 text-[11px] font-bold uppercase tracking-[0.5px] text-ink-subtle`}
        >
          <span>Vehículo</span>
          <span>Tipo</span>
          <span>Conductor</span>
          <span>Documentos</span>
          <span>ITV</span>
          <span>Estado</span>
          <span />
        </div>

        {vehicles.isError ? (
          <ErrorState className="py-10" onRetry={() => void vehicles.refetch()} />
        ) : vehicles.isLoading ? (
          <div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse border-b border-border bg-surface-2/40" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            className="py-12"
            title="Sin vehículos"
            description="No hay vehículos en esta vista."
          />
        ) : (
          rows.map((v) => {
            const isMoto = v.vehicleType === 'MOTO';
            const Icon = isMoto ? Bike : Car;
            const dp = docsPill(v);
            const ip = itvPill(v);
            const st = estado(v);
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => router.push(`/fleet/${v.id}`)}
                className={`${GRID} w-full border-b border-border px-5 py-[11px] text-left transition-colors last:border-b-0 hover:bg-surface-2/50`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-[34px] shrink-0 place-items-center rounded-sm border border-border bg-surface-2 text-ink-muted">
                    <Icon className="size-[17px]" aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-col gap-px">
                    <span className="truncate font-mono text-sm font-semibold text-ink">
                      {v.plate}
                    </span>
                    <span className="truncate text-[11px] text-ink-subtle">
                      {[v.brand, v.model].filter(Boolean).join(' ')}
                      {v.year ? ` · ${v.year}` : ''}
                    </span>
                  </div>
                </div>
                <span className="inline-flex w-fit items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-muted">
                  <Icon className="size-3" aria-hidden />
                  {isMoto ? 'Moto' : 'Auto'}
                </span>
                <span className="truncate text-[13px] text-ink-muted">{v.driverName ?? '—'}</span>
                <span>
                  <DotPill tone={dp.tone}>{dp.label}</DotPill>
                </span>
                <span>
                  <DotPill tone={ip.tone}>{ip.label}</DotPill>
                </span>
                <span>
                  <DotPill tone={st.tone}>{st.label}</DotPill>
                </span>
                <ChevronRight className="size-4 justify-self-end text-ink-subtle" aria-hidden />
              </button>
            );
          })
        )}

        <div className="flex items-center justify-between border-t border-border bg-surface-2 px-5 py-3">
          <span className="text-[13px] text-ink-subtle">
            {`Mostrando ${rows.length} vehículo${rows.length === 1 ? '' : 's'}`}
          </span>
          <LoadMore
            hasNextPage={!!vehicles.hasNextPage}
            isFetching={vehicles.isFetchingNextPage}
            onLoadMore={() => void vehicles.fetchNextPage()}
          />
        </div>
      </div>
    </div>
  );
}
