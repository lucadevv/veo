'use client';

import { type MouseEvent, useState } from 'react';
import { Inbox, CircleCheck, Banknote, Percent, ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { useRefunds, useRefundStats } from '@/lib/api/queries';
import { refundStatus, type RefundView } from '@/lib/api/schemas';
import { FILTER_ALL } from '@/lib/filters';
import { money, relativeAccess } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useRequestAccess } from '@/lib/use-request-access';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { ErrorState, PermissionState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { RefundStatusPill } from '@/components/finance/refund-status-pill';
import { RefundMethodCell } from '@/components/finance/refund-method';
import { ApproveRefundButton, RejectRefundButton } from '@/components/finance/refund-actions';
import { NewRefundDialog } from '@/components/finance/new-refund-dialog';
import { RefundDetailDialog } from '@/components/finance/refund-detail-dialog';

// Columnas fieles al T/RowReembolso (UaVQv): Viaje/Pasajero (nombre + trip) · Motivo · Monto · Método · Estado ·
// Solicitado (relativo) · Acción. `passengerName` lo enriquece el bff gateado por PII (FINANCE puro no ve
// identidad → null): cae al passengerId corto (honesto, nunca inventado). El estado usa el pill propio de la cola
// (Solicitado/Aprobado/Procesado/Rechazado), no el StatusPill genérico. La acción REFLEJA el estado: PENDING →
// aprobar/rechazar (money-OUT + step-up MFA); resto → chevron al detalle (la fila entera ya abre el sheet).
const columns: ColumnDef<RefundView, unknown>[] = [
  {
    accessorKey: 'passengerName',
    header: 'Viaje / Pasajero',
    cell: ({ row }) => {
      const { passengerName, passengerId, tripId } = row.original;
      return (
        <div className="flex flex-col gap-0.5">
          <span
            className={passengerName ? 'font-medium text-ink' : 'font-mono text-xs text-ink-muted'}
          >
            {passengerName ?? (passengerId ? `${passengerId.slice(0, 8)}…` : '—')}
          </span>
          <span className="font-mono text-xs text-ink-subtle">#{tripId.slice(0, 8)}</span>
        </div>
      );
    },
  },
  {
    accessorKey: 'reason',
    header: 'Motivo',
    cell: ({ row }) => <span className="text-ink-muted">{row.original.reason}</span>,
  },
  {
    accessorKey: 'amountCents',
    header: 'Monto',
    cell: ({ row }) => (
      <span className="tabular font-medium text-ink">{money(row.original.amountCents)}</span>
    ),
  },
  {
    accessorKey: 'method',
    header: 'Método',
    enableSorting: false,
    cell: ({ row }) => <RefundMethodCell method={row.original.method} />,
  },
  {
    accessorKey: 'status',
    header: 'Estado',
    cell: ({ row }) => <RefundStatusPill status={row.original.status} />,
  },
  {
    accessorKey: 'requestedAt',
    header: 'Solicitado',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-ink-muted">
        {relativeAccess(row.original.requestedAt)}
      </span>
    ),
  },
  {
    id: 'actions',
    header: '',
    enableSorting: false,
    cell: ({ row }) => {
      // Los botones viven DENTRO de la fila clickeable: frenamos la propagación para que aprobar/rechazar no
      // abra además el sheet de detalle.
      const stop = (e: MouseEvent) => e.stopPropagation();
      if (row.original.status === refundStatus.enum.PENDING) {
        return (
          <span onClick={stop} className="flex justify-end gap-2">
            <RejectRefundButton refundId={row.original.id} />
            <ApproveRefundButton refundId={row.original.id} amountCents={row.original.amountCents} />
          </span>
        );
      }
      return (
        <span className="flex justify-end text-ink-subtle">
          <ChevronRight className="size-4" aria-hidden />
        </span>
      );
    },
  },
];

// Opciones del dropdown "Estado" (fiel al frame): enum del contrato + 'Todos'. El value viaja al bff; 'ALL'
// (FILTER_ALL) lo dropea cleanQuery → trae todos. Labels de la cola (Solicitados/Aprobados/Procesados/Rechazados).
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: FILTER_ALL, label: 'Todos' },
  { value: refundStatus.enum.PENDING, label: 'Solicitados' },
  { value: refundStatus.enum.APPROVED, label: 'Aprobados' },
  { value: refundStatus.enum.COMPLETED, label: 'Procesados' },
  { value: refundStatus.enum.REJECTED, label: 'Rechazados' },
];

const EMPTY_BY_STATUS: Record<string, string> = {
  ALL: 'Todavía no hay solicitudes de reembolso.',
  PENDING: 'No hay reembolsos solicitados por aprobar.',
  APPROVED: 'No hay reembolsos aprobados en curso.',
  COMPLETED: 'No hay reembolsos procesados.',
  REJECTED: 'No hay reembolsos rechazados.',
};

export default function RefundsPage() {
  const user = useSession();
  const requestAccess = useRequestAccess();
  const [status, setStatus] = useState<string>(FILTER_ALL);
  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const query = useRefunds(status);
  const statsQuery = useRefundStats();

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Reembolsos"
          breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reembolsos' }]}
        />
        <PermissionState
          className="flex-1"
          section="Reembolsos"
          permission="finance:view"
          onRequest={() => requestAccess('finance:view')}
        />
      </div>
    );
  }

  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  // Búsqueda CLIENT-SIDE sobre las filas ya cargadas (identity no expone search-by-name): filtra por pasajero,
  // viaje o motivo. Honesto: solo ve lo cargado (paginación). Sin término, pasa todo.
  const term = search.trim().toLowerCase();
  const data = term
    ? rows.filter((r) =>
        [r.passengerName ?? r.passengerId ?? '', r.tripId, r.reason]
          .join(' ')
          .toLowerCase()
          .includes(term),
      )
    : rows;
  const stats = statsQuery.data;
  const canRefund = can(user, 'finance:refund');

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Reembolsos"
        description="Solicitudes de devolución a pasajeros · aprobá o rechazá cada una (money-OUT con step-up MFA, auditado)."
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reembolsos' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {/* KPIs fieles al frame HZ8uz — dato REAL de GET /finance/refunds/stats. */}
        <div className="pt-4">
          <StatCardGrid>
            <StatCard
              icon={Inbox}
              iconTone="warn"
              label="Solicitados"
              value={stats ? String(stats.requestedCount) : '—'}
              loading={statsQuery.isLoading}
            />
            <StatCard
              icon={CircleCheck}
              iconTone="brand"
              label="Aprobados"
              value={stats ? String(stats.approvedCount) : '—'}
              loading={statsQuery.isLoading}
            />
            <StatCard
              icon={Banknote}
              iconTone="success"
              label="Procesado hoy"
              value={stats ? money(stats.processedTodayCents) : '—'}
              loading={statsQuery.isLoading}
            />
            <StatCard
              icon={Percent}
              iconTone="neutral"
              label="Tasa de reembolso"
              // Derivada (% de cobros capturados reembolsados); null si aún no hay cobros capturados → "—" (no se inventa).
              value={stats ? (stats.refundRatePct === null ? '—' : `${stats.refundRatePct.toFixed(1)}%`) : '—'}
              loading={statsQuery.isLoading}
            />
          </StatCardGrid>
        </div>

        {/* Toolbar fiel al frame (T/TableToolbar): buscador (crece) · dropdown Estado · Nuevo reembolso. */}
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
          <div className="relative min-w-56 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
              aria-hidden
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar viaje o pasajero…"
              aria-label="Buscar viaje o pasajero"
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
          {canRefund ? <NewRefundDialog /> : null}
        </div>

        <div className="pt-4">
          {query.isError ? (
            <ErrorState onRetry={() => void query.refetch()} />
          ) : (
            <>
              <DataTable
                caption="Cola de reembolsos"
                columns={columns}
                data={data}
                loading={query.isLoading}
                onRowClick={(row) => setDetailId(row.id)}
                rowLabel={(row) =>
                  `Ver detalle del reembolso de ${row.passengerName ?? row.passengerId ?? row.tripId}`
                }
                emptyTitle="Cola vacía"
                emptyDescription={
                  term
                    ? `Sin resultados para "${search}".`
                    : (EMPTY_BY_STATUS[status] ?? 'No hay reembolsos para mostrar.')
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

      <RefundDetailDialog refundId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
