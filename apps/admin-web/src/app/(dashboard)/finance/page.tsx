'use client';

import { useState } from 'react';
import { Lock, Banknote, Clock, Pause, CircleAlert, Search } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { usePayouts, usePayoutStats } from '@/lib/api/queries';
import { payoutStatus, type PayoutView } from '@/lib/api/schemas';
import { FILTER_ALL } from '@/lib/filters';
import { money } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ReleaseHeldPayoutButton,
  RetryPayoutButton,
  RunPayoutsButton,
} from '@/components/finance/payout-actions';

// Columnas fieles al frame: Conductor (avatar + nombre, fallback driverId) · Período · Bruto · Comisión · Neto ·
// Estado (+heldReason en HELD) · Acción. `driverName` lo enriquece el bff desde identity — es null para roles
// que no ven PII (FINANCE puro · Ley 29733) o si el id no resuelve: en ese caso cae al driverId corto (honesto,
// nunca inventado). Comisión con signo negativo (se resta del bruto); el NETO en text-ink (dato protagonista).
const columns: ColumnDef<PayoutView, unknown>[] = [
  {
    accessorKey: 'driverName',
    header: 'Conductor',
    cell: ({ row }) => {
      const { driverName, driverId } = row.original;
      return (
        <div className="flex items-center gap-2.5">
          <Avatar name={driverName} size="sm" />
          <span
            className={driverName ? 'font-medium text-ink' : 'font-mono text-xs text-ink-muted'}
          >
            {driverName ?? driverId.slice(0, 8)}
          </span>
        </div>
      );
    },
  },
  {
    accessorKey: 'period',
    header: 'Período',
    cell: ({ row }) => <span className="text-ink-muted">{row.original.period}</span>,
  },
  {
    accessorKey: 'grossCents',
    header: 'Bruto',
    cell: ({ row }) => (
      <span className="tabular text-ink-muted">{money(row.original.grossCents)}</span>
    ),
  },
  {
    accessorKey: 'commissionCents',
    header: 'Comisión',
    cell: ({ row }) => (
      <span className="tabular text-ink-subtle">−{money(row.original.commissionCents)}</span>
    ),
  },
  {
    accessorKey: 'amountCents',
    header: 'Neto',
    cell: ({ row }) => (
      <span className="tabular font-medium text-ink">{money(row.original.amountCents)}</span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Estado',
    // El estado, y SOLO en HELD, el motivo de retención como subtítulo discreto (heldReason solo poblado en HELD).
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <StatusPill status={row.original.status} />
        {row.original.status === payoutStatus.enum.HELD && row.original.heldReason ? (
          <span className="text-xs text-ink-muted">{row.original.heldReason}</span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'actions',
    header: 'Acción',
    // Acción que REFLEJA el estado: HELD → liberar la retención (camino de vuelta de driver.flagged); FAILED →
    // reintentar el desembolso (ADR-015 §5). Ambos botones se auto-ocultan sin finance:payout. `status` es el
    // enum tipado del contrato (payoutStatus): nada de literales sueltos.
    cell: ({ row }) => {
      if (row.original.status === payoutStatus.enum.HELD) {
        return (
          <ReleaseHeldPayoutButton
            driverId={row.original.driverId}
            amountCents={row.original.amountCents}
          />
        );
      }
      if (row.original.status === payoutStatus.enum.FAILED) {
        return (
          <RetryPayoutButton payoutId={row.original.id} amountCents={row.original.amountCents} />
        );
      }
      return <span className="text-ink-subtle">—</span>;
    },
  },
];

// Tabs por estado (fieles al frame: Todos → Fallidos). El value es el enum del contrato; 'ALL' (FILTER_ALL) lo
// dropea cleanQuery en el bff → trae todos.
const TABS: { value: string; label: string }[] = [
  { value: FILTER_ALL, label: 'Todos' },
  { value: payoutStatus.enum.PENDING, label: 'Pendientes' },
  { value: payoutStatus.enum.PROCESSING, label: 'Procesando' },
  { value: payoutStatus.enum.PROCESSED, label: 'Procesados' },
  { value: payoutStatus.enum.HELD, label: 'Retenidos' },
  { value: payoutStatus.enum.FAILED, label: 'Fallidos' },
];

const EMPTY_BY_TAB: Record<string, string> = {
  ALL: 'Todavía no se generó ninguna liquidación.',
  PENDING: 'No hay liquidaciones pendientes de pago.',
  PROCESSING: 'No hay liquidaciones en proceso.',
  PROCESSED: 'No hay liquidaciones procesadas.',
  HELD: 'No hay liquidaciones retenidas.',
  FAILED: 'No hay liquidaciones fallidas.',
};

export default function FinancePage() {
  const user = useSession();
  const [tab, setTab] = useState<string>(FILTER_ALL);
  const [search, setSearch] = useState('');
  const query = usePayouts(tab);
  const statsQuery = usePayoutStats();

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Liquidaciones" breadcrumbs={[{ label: 'Finanzas' }]} />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver liquidaciones."
        />
      </div>
    );
  }

  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  // Búsqueda CLIENT-SIDE sobre las filas ya cargadas (identity no expone search-by-name; una búsqueda global
  // requeriría un endpoint nuevo). Filtra por nombre enriquecido o, si no hay, por driverId. Honesto: solo ve
  // lo que se cargó (paginación). Sin término, pasa todo.
  const term = search.trim().toLowerCase();
  const data = term
    ? rows.filter((r) => (r.driverName ?? r.driverId).toLowerCase().includes(term))
    : rows;
  const stats = statsQuery.data;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Liquidaciones"
        description="Payouts semanales · el neto = ganancia digital − comisión y deuda CASH neteadas."
        breadcrumbs={[{ label: 'Finanzas' }]}
        actions={can(user, 'finance:payout') ? <RunPayoutsButton /> : null}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* KPIs — dato REAL de GET /finance/payouts/stats (StatCard no renderiza valor sin backend). */}
        <div className="pt-4">
          <StatCardGrid>
            <StatCard
              icon={Banknote}
              label="Total del período"
              value={stats ? money(stats.totalCents) : '—'}
              hint="total liquidado"
              loading={statsQuery.isLoading}
            />
            <StatCard
              icon={Clock}
              label="Pendientes de disparo"
              value={stats ? String(stats.pendingCount) : '—'}
              hint="a la espera del run"
              hintTone="warn"
              loading={statsQuery.isLoading}
            />
            <StatCard
              icon={Pause}
              label="Retenidos (review)"
              value={stats ? String(stats.heldCount) : '—'}
              hint="conductores flaggeados"
              loading={statsQuery.isLoading}
            />
            <StatCard
              icon={CircleAlert}
              label="Fallidos"
              value={stats ? String(stats.failedCount) : '—'}
              hint="requieren reintento"
              hintTone="danger"
              loading={statsQuery.isLoading}
            />
          </StatCardGrid>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="relative w-64 max-w-full">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
                aria-hidden
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar conductor…"
                aria-label="Buscar conductor"
                className="w-full rounded-md border border-border bg-surface py-1.5 pl-8 pr-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none"
              />
            </div>
          </div>
          <TabsContent value={tab}>
            {query.isError ? (
              <ErrorState onRetry={() => void query.refetch()} />
            ) : (
              <>
                <DataTable
                  caption="Liquidaciones"
                  columns={columns}
                  data={data}
                  loading={query.isLoading}
                  emptyTitle="Sin liquidaciones"
                  emptyDescription={
                    term
                      ? `Sin resultados para "${search}".`
                      : (EMPTY_BY_TAB[tab] ?? 'No hay liquidaciones para mostrar.')
                  }
                />
                <LoadMore
                  hasNextPage={!!query.hasNextPage}
                  isFetching={query.isFetchingNextPage}
                  onLoadMore={() => void query.fetchNextPage()}
                />
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
