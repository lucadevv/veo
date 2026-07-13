'use client';

import { type MouseEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wallet, CircleCheck, Pause, CircleX, ChevronDown, Search } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { usePayouts, usePayoutStats } from '@/lib/api/queries';
import { payoutStatus, type PayoutView } from '@/lib/api/schemas';
import { FILTER_ALL } from '@/lib/filters';
import { money, payoutPeriod } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useRequestAccess } from '@/lib/use-request-access';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { MoneyStat, MoneyStatGrid } from '@/components/finance/money-stat-grid';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState, PermissionState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  ReleaseHeldPayoutButton,
  RetryPayoutButton,
  RunPayoutsButton,
} from '@/components/finance/payout-actions';
import { ExportCsvButton } from '@/components/finance/export-csv-button';

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
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-ink-muted">{payoutPeriod(row.original.period)}</span>
    ),
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
      // La fila entera abre el detalle (onRowClick); los botones de acción viven DENTRO de la fila, así
      // que frenamos la propagación acá para que disparar/liberar/reintentar NO abra además el sheet.
      const stop = (e: MouseEvent) => e.stopPropagation();
      if (row.original.status === payoutStatus.enum.HELD) {
        return (
          <span onClick={stop}>
            <ReleaseHeldPayoutButton
              driverId={row.original.driverId}
              amountCents={row.original.amountCents}
            />
          </span>
        );
      }
      if (row.original.status === payoutStatus.enum.FAILED) {
        return (
          <span onClick={stop}>
            <RetryPayoutButton payoutId={row.original.id} amountCents={row.original.amountCents} />
          </span>
        );
      }
      return <span className="text-ink-subtle">—</span>;
    },
  },
];

// Opciones del dropdown "Estado" de la toolbar (fiel al frame idllB: reemplaza los 6 tabs). El value es el enum
// del contrato; 'ALL' (FILTER_ALL) lo dropea cleanQuery en el bff → trae todos.
const STATUS_OPTIONS: { value: string; label: string }[] = [
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
  const router = useRouter();
  const requestAccess = useRequestAccess();
  const [status, setStatus] = useState<string>(FILTER_ALL);
  const [search, setSearch] = useState('');
  const query = usePayouts(status);
  const statsQuery = usePayoutStats();

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Liquidaciones" breadcrumbs={[{ label: 'Finanzas' }]} />
        <PermissionState
          className="flex-1"
          section="Liquidaciones"
          permission="finance:view"
          onRequest={() => requestAccess('finance:view')}
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
        breadcrumbs={[{ label: 'Finanzas' }]}
        actions={can(user, 'finance:payout') ? <RunPayoutsButton /> : null}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* KPIs money fieles al frame idllB — dato REAL de GET /finance/payouts/stats (los 4 buckets en céntimos).
            A pagar = volumen total del período (totalCents: no hay bucket "pendiente-de-pago" propio); el resto,
            su bucket money. Iconos alineados al frame (wallet/circle-check/pause/circle-x). */}
        <div className="pt-4">
          <MoneyStatGrid>
            <MoneyStat
              icon={Wallet}
              iconTone="brand"
              label="A pagar"
              value={stats ? money(stats.totalCents) : '—'}
              loading={statsQuery.isLoading}
            />
            <MoneyStat
              icon={CircleCheck}
              iconTone="success"
              label="Pagado (periodo)"
              value={stats ? money(stats.paidCents) : '—'}
              loading={statsQuery.isLoading}
            />
            <MoneyStat
              icon={Pause}
              iconTone="warn"
              label="Retenido"
              value={stats ? money(stats.heldCents) : '—'}
              loading={statsQuery.isLoading}
            />
            <MoneyStat
              icon={CircleX}
              iconTone="danger"
              label="Con error"
              value={stats ? money(stats.failedCents) : '—'}
              // Señal: si hay plata rechazada por el riel, la card entera se tinta (no solo el número).
              alert={stats && stats.failedCents > 0 ? 'danger' : false}
              loading={statsQuery.isLoading}
            />
          </MoneyStatGrid>
        </div>

        {/* Toolbar fiel al frame (T/TableToolbar): buscador (crece) · dropdown Estado · Exportar CSV. */}
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
          <div className="relative min-w-56 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
              aria-hidden
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar conductor…"
              aria-label="Buscar conductor"
              className="w-full rounded-md border border-border bg-surface-2 py-1.5 pl-8 pr-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-surface-2 px-3 text-sm font-medium text-ink transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                {status === FILTER_ALL
                  ? 'Estado'
                  : (STATUS_OPTIONS.find((o) => o.value === status)?.label ?? 'Estado')}
                <ChevronDown className="size-4 text-ink-subtle" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {STATUS_OPTIONS.map((o) => (
                <DropdownMenuItem
                  key={o.value}
                  onSelect={() => setStatus(o.value)}
                  className={cn(o.value === status && 'font-semibold text-brand')}
                >
                  {o.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ExportCsvButton status={status} />
        </div>

        <div className="pt-4">
          {query.isError ? (
            <ErrorState onRetry={() => void query.refetch()} />
          ) : (
            <>
              <DataTable
                caption="Liquidaciones"
                columns={columns}
                data={data}
                loading={query.isLoading}
                onRowClick={(row) => router.push(`/finance/${row.id}`)}
                rowLabel={(row) =>
                  `Ver detalle de la liquidación de ${row.driverName ?? row.driverId}`
                }
                emptyTitle="Sin liquidaciones"
                emptyDescription={
                  term
                    ? `Sin resultados para "${search}".`
                    : (EMPTY_BY_TAB[status] ?? 'No hay liquidaciones para mostrar.')
                }
              />
              <LoadMore
                hasNextPage={!!query.hasNextPage}
                isFetching={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
