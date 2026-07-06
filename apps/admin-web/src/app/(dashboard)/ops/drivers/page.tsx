'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BadgeCheck,
  ChevronRight,
  ClipboardCheck,
  Download,
  FileWarning,
  Lock,
  ScanFace,
  Search,
} from 'lucide-react';
import { useDrivers, useDriversPending, useDriversSummary } from '@/lib/api/queries';
import type { DriverApproval, PendingDriver } from '@/lib/api/schemas';
import { date } from '@/lib/formatters';
import { downloadCsv } from '@/lib/csv';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { StatCard } from '@/components/ui/stat-card';
import { Avatar } from '@/components/ui/avatar';
import { DotPill, type PillTone } from '@/components/ui/dot-pill';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';

/** Fecha corta "DD mmm" (formato de la columna Actualizado del frame). */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')} ${MESES[d.getMonth()]}`;
}

/** Fila NORMALIZADA de la tabla (unifica DriverApproval de la lista y PendingDriver de la cola). */
interface Row {
  id: string;
  fullName: string | null;
  docsComplete: number;
  docsTotal: number;
  verificationStatus: string | null;
  backgroundStatus: string;
  updatedAt: string | null;
}

// Labels de las columnas (fuente ÚNICA: los pills Y el export CSV los consumen — sin duplicar strings).
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

/** Pill de Documentos: "X/Y completos" en brand si están todos; "Faltan N" neutro si falta alguno. */
function DocsPill({ complete, total }: { complete: number; total: number }) {
  const done = total > 0 && complete >= total;
  return <DotPill tone={done ? 'brand' : 'neutral'}>{docsLabel(complete, total)}</DotPill>;
}

/** Pill de Verificación: VERIFICADO→Verificado (success) · REVISAR→Cotejado (warn) · PENDIENTE→Sin enrolar (neutro). */
function VerifPill({ status }: { status: string | null }) {
  if (status === null) return <span className="text-ink-subtle">—</span>;
  const m = VERIF_MAP[status] ?? { tone: 'neutral' as PillTone, label: 'Sin enrolar' };
  return <DotPill tone={m.tone}>{m.label}</DotPill>;
}

/** Pill de Estado: Aprobado (CLEARED) · Rechazado (REJECTED) · En revisión (pendiente con docs) · Pendiente. */
function EstadoPill({ row }: { row: Row }) {
  if (row.backgroundStatus === 'CLEARED') return <DotPill tone="success">Aprobado</DotPill>;
  if (row.backgroundStatus === 'REJECTED') return <DotPill tone="danger">Rechazado</DotPill>;
  const docsOk = row.docsTotal > 0 && row.docsComplete >= row.docsTotal;
  return docsOk ? <DotPill tone="warn">En revisión</DotPill> : <DotPill tone="muted">Pendiente</DotPill>;
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
});

const pendingToRow = (d: PendingDriver): Row => ({
  id: d.id,
  fullName: d.fullName,
  docsComplete: d.docsComplete,
  docsTotal: d.docsTotal,
  verificationStatus: d.verificationStatus,
  backgroundStatus: 'PENDING',
  updatedAt: null,
});

const GRID = 'grid grid-cols-[1fr_150px_150px_140px_90px_24px] items-center gap-4';

export default function DriversPage() {
  const router = useRouter();
  const user = useSession();
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
  const tabCount: Record<Tab, number | undefined> = {
    todos: total,
    sinDocs: c?.sinDocs,
    listos: c?.listos,
    enRevision: c?.enRevision,
    aprobados: undefined,
    rechazados: undefined,
  };

  if (!can(user, 'drivers:view')) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <Lock className="size-6 text-ink-subtle" aria-hidden />
        <p className="text-sm text-ink-muted">
          Necesitás el rol correspondiente para ver los conductores.
        </p>
      </div>
    );
  }

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

  return (
    <div className="flex h-full min-h-0 flex-col gap-[22px] overflow-auto px-8 py-7">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Conductores</h1>
          <p className="text-[13px] text-ink-subtle">Cola de revisión · aprobación de la flota</p>
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

      {/* Stat cards del embudo */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={FileWarning}
          label="Sin documentos"
          value={String(c?.sinDocs ?? 0)}
          hint="Esperando al conductor"
          loading={summary.isLoading}
        />
        <StatCard
          icon={ClipboardCheck}
          label="Listos para revisar"
          value={String(c?.listos ?? 0)}
          hint="Docs completos"
          hintTone="warn"
          loading={summary.isLoading}
        />
        <StatCard
          icon={ScanFace}
          label="En revisión"
          value={String(c?.enRevision ?? 0)}
          hint="Cotejo en curso"
          loading={summary.isLoading}
        />
        <StatCard
          icon={BadgeCheck}
          label="Aprobados"
          value={String(c?.cleared ?? 0)}
          hint="Antecedentes limpios"
          hintTone="success"
          loading={summary.isLoading}
        />
      </div>

      {/* Toolbar: pill-tabs + search */}
      <div className="flex items-center justify-between gap-4">
        <div className="inline-flex gap-[3px] rounded-md border border-border bg-surface p-1">
          {TABS.map(({ key, label }) => {
            const active = tab === key;
            const n = tabCount[key];
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
                {n !== undefined ? (
                  <span
                    className={`inline-flex min-w-[18px] justify-center rounded-full px-[7px] py-px font-mono text-[11px] font-bold ${
                      active ? 'bg-accent text-accent-on' : 'bg-surface-2 text-ink-subtle'
                    }`}
                  >
                    {n}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="inline-flex w-[280px] items-center gap-2 rounded-sm border border-border bg-bg px-3 py-[9px]">
          <Search className="size-4 shrink-0 text-ink-subtle" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar conductor, DNI o placa…"
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle"
          />
        </div>
      </div>

      {/* Tabla */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div
          className={`${GRID} border-b border-border bg-surface-2 px-5 py-3 text-[11px] font-bold uppercase tracking-[0.5px] text-ink-subtle`}
        >
          <span>Conductor</span>
          <span>Documentos</span>
          <span>Verificación</span>
          <span>Estado</span>
          <span>Actualizado</span>
          <span />
        </div>

        {isError ? (
          <ErrorState
            className="py-10"
            onRetry={() => void (usePendingSource ? pending.refetch() : fleet.refetch())}
          />
        ) : isLoading ? (
          <div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse border-b border-border bg-surface-2/40" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            className="py-12"
            title="Sin conductores"
            description="No hay conductores en esta vista."
          />
        ) : (
          rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => router.push(`/ops/drivers/${r.id}`)}
              className={`${GRID} w-full border-b border-border px-5 py-[11px] text-left transition-colors last:border-b-0 hover:bg-surface-2/50`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={r.fullName} size="sm" />
                <div className="flex min-w-0 flex-col gap-px">
                  <span className="truncate text-sm font-semibold text-ink">
                    {r.fullName ?? 'Sin nombre'}
                  </span>
                  <span className="truncate font-mono text-[11px] text-ink-subtle">
                    {`drv_${r.id.slice(0, 5)}`}
                  </span>
                </div>
              </div>
              <span>
                <DocsPill complete={r.docsComplete} total={r.docsTotal} />
              </span>
              <span>
                <VerifPill status={r.verificationStatus} />
              </span>
              <span>
                <EstadoPill row={r} />
              </span>
              <span className="text-[13px] text-ink-muted">{shortDate(r.updatedAt)}</span>
              <ChevronRight className="size-4 justify-self-end text-ink-subtle" aria-hidden />
            </button>
          ))
        )}

        <div className="flex items-center justify-between border-t border-border bg-surface-2 px-5 py-3">
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
    </div>
  );
}
