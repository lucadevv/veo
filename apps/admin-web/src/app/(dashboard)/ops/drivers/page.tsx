'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, CircleDot, Clock, Download, Search, Users, type LucideIcon } from 'lucide-react';
import { DriverStatus } from '@veo/shared-types';
import { useDrivers, useDriversPending, useDriversSummary } from '@/lib/api/queries';
import type { DriverApproval, PendingDriver } from '@/lib/api/schemas';
import { date } from '@/lib/formatters';
import { downloadCsv } from '@/lib/csv';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { cn } from '@/lib/cn';
import { AdminTopbar } from '@/components/layout/admin-topbar';
import { Avatar } from '@/components/ui/avatar';
import { DotPill, type PillTone } from '@/components/ui/dot-pill';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';
import { useRequestAccess } from '@/lib/use-request-access';

/** Fila NORMALIZADA de la tabla (unifica DriverApproval de la lista y PendingDriver de la cola). */
interface Row {
  id: string;
  fullName: string | null;
  docsComplete: number;
  docsTotal: number;
  verificationStatus: string | null;
  backgroundStatus: string;
  updatedAt: string | null;
  /** Rating promedio (columna CALIF.) — solo la lista de flota lo trae; null en la cola de pendientes. */
  rating: number | null;
  /** Estado de CICLO DE VIDA del read-model (PENDING/ACTIVE/REJECTED/SUSPENDED) — lo usa el badge KYC
   *  (SUSPENDED). NO es presencia. null en la cola de pendientes. */
  driverStatus: string | null;
  /** Presencia OPERATIVA real (identity.currentStatus: OFFLINE/AVAILABLE/ON_TRIP/…) para la columna ESTADO
   *  (En línea/Offline). Eje distinto del ciclo de vida; null en la cola (no la proyecta). */
  operationalStatus: string | null;
}

// Labels de las columnas (fuente ÚNICA: el export CSV los consume — sin duplicar strings).
const docsLabel = (complete: number, total: number): string =>
  total > 0 && complete >= total
    ? `${complete}/${total} completos`
    : `Faltan ${Math.max(total - complete, 0)}`;

const VERIF_MAP: Record<string, { tone: PillTone; label: string }> = {
  VERIFICADO: { tone: 'success', label: 'Verificado' },
  REVISAR: { tone: 'warn', label: 'Cotejado' },
  PENDIENTE: { tone: 'neutral', label: 'Sin enrolar' },
};
const verifLabel = (status: string | null): string =>
  status === null ? '' : (VERIF_MAP[status]?.label ?? 'Sin enrolar');

const estadoLabel = (row: Row): string => {
  if (row.backgroundStatus === 'CLEARED') return 'Aprobado';
  if (row.backgroundStatus === 'REJECTED') return 'Rechazado';
  return row.docsTotal > 0 && row.docsComplete >= row.docsTotal ? 'En revisión' : 'Pendiente';
};

/** Badge KYC (columna KYC): Verificado (success) · Pendiente (warn) · Rechazado/Suspendido (danger). */
function kycBadge(row: Row): { tone: PillTone; label: string } {
  if (row.driverStatus === DriverStatus.SUSPENDED) return { tone: 'danger', label: 'Suspendido' };
  if (row.backgroundStatus === 'REJECTED') return { tone: 'danger', label: 'Rechazado' };
  if (row.backgroundStatus === 'CLEARED' || row.verificationStatus === 'VERIFICADO')
    return { tone: 'success', label: 'Verificado' };
  return { tone: 'warn', label: 'Pendiente' };
}

/**
 * Presencia OPERATIVA (columna ESTADO): En línea (verde) si el conductor está conectado, Offline si no.
 * Consume `operationalStatus` = identity.currentStatus AUTORITATIVO (OFFLINE/AVAILABLE/ON_TRIP/…), NO el
 * status de ciclo de vida del read-model — ese solo vale PENDING/ACTIVE/REJECTED/SUSPENDED y hacía que un
 * postulante PENDING (nunca OFFLINE en ese eje) se pintara "En línea". "—" si la fuente no la trae (cola).
 */
function Presence({ status }: { status: string | null }) {
  if (status === null) return <span className="text-ink-subtle">—</span>;
  const online = status !== DriverStatus.OFFLINE && status !== DriverStatus.SUSPENDED;
  return (
    <span className="inline-flex items-center gap-2 text-[13px] font-medium">
      <span
        className={cn('size-2 shrink-0 rounded-full', online ? 'bg-success' : 'bg-ink-subtle')}
        aria-hidden
      />
      <span className={online ? 'text-ink' : 'text-ink-muted'}>{online ? 'En línea' : 'Offline'}</span>
    </span>
  );
}

type Tab = 'todos' | 'sinDocs' | 'listos' | 'enRevision' | 'aprobados' | 'rechazados';

const TABS: { key: Tab; label: string }[] = [
  { key: 'todos', label: 'Todos' },
  { key: 'sinDocs', label: 'Sin docs' },
  { key: 'listos', label: 'Listos' },
  { key: 'enRevision', label: 'En revisión' },
  { key: 'aprobados', label: 'Aprobados' },
  { key: 'rechazados', label: 'Rechazados' },
];

const approvalToRow = (d: DriverApproval): Row => ({
  id: d.id,
  fullName: d.fullName,
  docsComplete: d.docsComplete,
  docsTotal: d.docsTotal,
  verificationStatus: d.verificationStatus,
  backgroundStatus: d.backgroundCheckStatus,
  updatedAt: d.submittedAt,
  rating: d.averageRating,
  driverStatus: d.status,
  operationalStatus: d.operationalStatus,
});

const pendingToRow = (d: PendingDriver): Row => ({
  id: d.id,
  fullName: d.fullName,
  docsComplete: d.docsComplete,
  docsTotal: d.docsTotal,
  verificationStatus: d.verificationStatus,
  backgroundStatus: 'PENDING',
  updatedAt: null,
  rating: null,
  driverStatus: null,
  operationalStatus: null,
});

/** KPI card fiel al kpi-grid.tsx del panel (label tenue + dígito Space Grotesk). Valor "—" honesto sin seam. */
/** Tono del cuadro del icono por KPI (fiel al frame: neutral/verde/ámbar/rojo). */
const KPI_TONE: Record<'neutral' | 'success' | 'warn' | 'danger', string> = {
  neutral: 'bg-ink/[0.06] text-ink-muted',
  success: 'bg-success/10 text-success',
  warn: 'bg-warn/12 text-warn',
  danger: 'bg-danger/10 text-danger',
};

function Kpi({
  label,
  value,
  loading,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  loading?: boolean;
  icon: LucideIcon;
  tone: keyof typeof KPI_TONE;
}) {
  return (
    <div className="flex items-center gap-3.5 rounded-[18px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <span className={cn('grid size-11 shrink-0 place-items-center rounded-[13px]', KPI_TONE[tone])}>
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {loading ? (
          <div className="h-8 w-16 animate-pulse rounded-md bg-surface-2" />
        ) : (
          <p className="font-display text-[28px] font-bold leading-none tracking-[-1px] tabular text-ink">
            {value}
          </p>
        )}
        <p className="text-[13px] font-medium text-ink-muted">{label}</p>
      </div>
    </div>
  );
}

export default function DriversPage() {
  const router = useRouter();
  const user = useSession();
  const requestAccess = useRequestAccess();
  const [tab, setTab] = useState<Tab>('todos');
  const [search, setSearch] = useState('');

  const summary = useDriversSummary();
  const pending = useDriversPending();
  // Tabs no-embudo (Todos/Aprobados/Rechazados) → read-model por status; los del embudo → cola de pendientes.
  const fleetStatus = tab === 'aprobados' ? 'ACTIVE' : tab === 'rechazados' ? 'REJECTED' : 'ALL';
  const usePendingSource = tab === 'sinDocs' || tab === 'listos' || tab === 'enRevision';
  const fleet = useDrivers(fleetStatus);

  const rows = useMemo<Row[]>(() => {
    let base: Row[];
    if (usePendingSource) {
      const all = (pending.data ?? []).map(pendingToRow);
      base = all.filter((r) => {
        const docsOk = r.docsTotal > 0 && r.docsComplete >= r.docsTotal;
        if (tab === 'sinDocs') return !docsOk;
        if (tab === 'listos') return docsOk && r.verificationStatus === 'PENDIENTE';
        return docsOk && r.verificationStatus !== 'PENDIENTE'; // enRevision
      });
    } else {
      base = (fleet.data?.pages.flatMap((p) => p.items) ?? []).map(approvalToRow);
    }
    const q = search.trim().toLowerCase();
    return q ? base.filter((r) => (r.fullName ?? '').toLowerCase().includes(q)) : base;
  }, [usePendingSource, pending.data, fleet.data, tab, search]);

  const c = summary.data;
  const total = c ? c.sinDocs + c.listos + c.enRevision + c.cleared + c.rejected : undefined;
  const pendientesKyc = c ? c.sinDocs + c.listos + c.enRevision : undefined;
  const tabCount: Record<Tab, number | undefined> = {
    todos: total,
    sinDocs: c?.sinDocs,
    listos: c?.listos,
    enRevision: c?.enRevision,
    aprobados: undefined,
    rechazados: undefined,
  };

  const isLoading = usePendingSource ? pending.isLoading : fleet.isLoading;
  const isError = usePendingSource ? pending.isError : fleet.isError;

  const exportCsv = () =>
    downloadCsv(
      'veo-conductores.csv',
      ['Conductor', 'ID', 'Documentos', 'Verificación', 'Estado', 'Actualizado'],
      rows.map((r) => [
        r.fullName ?? '',
        `drv_${r.id.slice(0, 8)}`,
        docsLabel(r.docsComplete, r.docsTotal),
        verifLabel(r.verificationStatus),
        estadoLabel(r),
        r.updatedAt ? date(r.updatedAt) : '',
      ]),
    );

  const topbar = (
    <AdminTopbar
      title="Conductores"
      subtitle={
        total !== undefined
          ? `${total} conductores${c ? ` · ${c.online} en línea` : ''}`
          : 'Cola de revisión · aprobación de la flota'
      }
      actions={
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-2 rounded-control bg-accent px-[18px] py-[11px] text-sm font-semibold text-accent-on shadow-brand transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Download className="size-4" aria-hidden />
          Exportar
        </button>
      }
    />
  );

  if (!can(user, 'drivers:view')) {
    return (
      <div className="flex h-full flex-col">
        {topbar}
        <PermissionState
          className="flex-1"
          section="Conductores"
          permission="drivers:view"
          onRequest={() => requestAccess('drivers:view')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {topbar}

      <div className="flex flex-1 flex-col gap-[22px] overflow-y-auto p-7">
        {/* KPIs — Total, En línea y Pendientes KYC del summary real; Suspendidos sin seam → "—" honesto. */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Kpi label="Total" value={String(total ?? 0)} loading={summary.isLoading} icon={Users} tone="neutral" />
          <Kpi
            label="En línea"
            value={c ? String(c.online) : '—'}
            loading={summary.isLoading}
            icon={CircleDot}
            tone="success"
          />
          <Kpi
            label="Pendientes KYC"
            value={String(pendientesKyc ?? 0)}
            loading={summary.isLoading}
            icon={Clock}
            tone="warn"
          />
          <Kpi label="Suspendidos" value="—" icon={Ban} tone="danger" />
        </div>

        {/* Toolbar: filtro KYC (tabs) + búsqueda */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="inline-flex flex-wrap gap-[3px] rounded-control border border-border bg-surface p-1">
            {TABS.map(({ key, label }) => {
              const active = tab === key;
              const n = tabCount[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-[10px] px-3 py-[7px] text-[13px] font-semibold transition-colors',
                    active ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {label}
                  {n !== undefined ? (
                    <span
                      className={cn(
                        'inline-flex min-w-[18px] justify-center rounded-full px-[7px] py-px font-mono text-[11px] font-bold',
                        active ? 'bg-accent text-accent-on' : 'bg-surface-2 text-ink-subtle',
                      )}
                    >
                      {n}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="inline-flex w-[300px] items-center gap-2 rounded-control border border-border bg-surface px-3.5 py-2.5">
            <Search className="size-4 shrink-0 text-ink-subtle" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar conductor…"
              className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle"
            />
          </div>
        </div>

        {/* Tabla */}
        {isError ? (
          <ErrorState
            className="rounded-lg border border-black/[0.05] bg-surface py-14 shadow-3"
            onRetry={() => void (usePendingSource ? pending.refetch() : fleet.refetch())}
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-black/[0.05] bg-surface shadow-3">
            {/* Header */}
            <div className="flex items-center gap-4 border-b border-[color:var(--divider)] bg-bg px-[22px] py-3 text-[11px] font-bold uppercase tracking-[0.05em] text-ink-subtle">
              <span className="flex-1">Conductor</span>
              <span className="hidden w-[160px] shrink-0 lg:block">Vehículo</span>
              <span className="w-[130px] shrink-0">KYC</span>
              <span className="hidden w-[70px] shrink-0 md:block">Calif.</span>
              <span className="hidden w-[70px] shrink-0 xl:block">Viajes</span>
              <span className="w-[120px] shrink-0">Estado</span>
            </div>

            {isLoading ? (
              <div className="space-y-px p-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-2/50" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                className="py-14"
                title="Sin conductores"
                description="No hay conductores en esta vista."
              />
            ) : (
              <ul>
                {rows.map((r, i) => {
                  const kyc = kycBadge(r);
                  return (
                    <li
                      key={r.id}
                      onClick={() => router.push(`/ops/drivers/${r.id}`)}
                      className={cn(
                        'flex cursor-pointer items-center gap-4 px-[22px] py-3.5 transition-colors hover:bg-surface-2',
                        i < rows.length - 1 ? 'border-b border-[color:var(--divider)]' : '',
                      )}
                    >
                      {/* Conductor */}
                      <span className="flex min-w-0 flex-1 items-center gap-3">
                        <Avatar name={r.fullName} size="sm" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-semibold text-ink">
                            {r.fullName ?? 'Sin nombre'}
                          </span>
                          <span className="truncate font-mono text-[11px] text-ink-subtle">
                            {`drv_${r.id.slice(0, 8)}`}
                          </span>
                        </span>
                      </span>

                      {/* Vehículo — no está en la proyección de la lista → "—" honesto */}
                      <span className="hidden w-[160px] shrink-0 text-[13px] text-ink-subtle lg:block">
                        —
                      </span>

                      {/* KYC */}
                      <span className="w-[130px] shrink-0">
                        <DotPill tone={kyc.tone}>{kyc.label}</DotPill>
                      </span>

                      {/* Calif. */}
                      <span className="hidden w-[70px] shrink-0 text-[13px] font-medium text-ink md:block tabular">
                        {r.rating != null ? r.rating.toFixed(2) : '—'}
                      </span>

                      {/* Viajes — no está en la proyección de la lista → "—" honesto */}
                      <span className="hidden w-[70px] shrink-0 text-[13px] text-ink-subtle xl:block">
                        —
                      </span>

                      {/* Estado — presencia OPERATIVA real (identity.currentStatus), no el ciclo de vida */}
                      <span className="w-[120px] shrink-0">
                        <Presence status={r.operationalStatus} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex items-center justify-between border-t border-[color:var(--divider)] bg-bg px-[22px] py-3">
              <span className="text-[13px] text-ink-subtle">
                {`Mostrando ${rows.length} conductor${rows.length === 1 ? '' : 'es'}`}
              </span>
              {!usePendingSource ? (
                <LoadMore
                  hasNextPage={!!fleet.hasNextPage}
                  isFetching={fleet.isFetchingNextPage}
                  onLoadMore={() => void fleet.fetchNextPage()}
                />
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
