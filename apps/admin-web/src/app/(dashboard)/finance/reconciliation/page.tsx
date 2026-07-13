'use client';

import type { LucideIcon } from 'lucide-react';
import { Equal, Scale, Database, FileText } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { useReconciliation } from '@/lib/api/queries';
import type { ReconciliationRunView } from '@/lib/api/schemas';
import { money } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useRequestAccess } from '@/lib/use-request-access';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, PermissionState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadMore } from '@/components/ui/load-more';

/** Discrepancia 0..1 → porcentaje con 2 decimales. */
function pct(p: number): string {
  return `${(p * 100).toFixed(2)} %`;
}

/**
 * HONESTIDAD: el proveedor (ProntoPaga) devuelve extracto vacío en prod (getStatement() → []), así que una
 * corrida con cobros en DB pero 0 movimientos de extracto sale con discrepancia ~100% y `alerted=true` — una
 * ALERTA ENGAÑOSA. No es una discrepancia real: es que no hay extracto contra qué cruzar. Se distingue por el
 * contrato (`statementCount === 0 && statementTotalCents === 0`) teniendo DB con monto (`dbTotalCents > 0`).
 * En ese caso NO pintamos alerta roja: mostramos un estado neutral "Sin extracto".
 */
function isStatementMissing(run: ReconciliationRunView): boolean {
  return run.statementCount === 0 && run.statementTotalCents === 0 && run.dbTotalCents > 0;
}

const DATE_FMT = new Intl.DateTimeFormat('es-PE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
function fmtDate(iso: string): string {
  return DATE_FMT.format(new Date(iso));
}

/**
 * Una card del cruce (DB o Extracto): icono + label · valor grande · sub.
 * `muted` = el valor no es un monto real sino un estado honesto ("Sin extracto"): se pinta chico y en gris,
 * para NO leerse como un S/ 0.00 conciliado.
 */
function CompareCard({
  icon: Icon,
  label,
  value,
  sub,
  muted = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  muted?: boolean;
}) {
  return (
    <div className="flex-1 rounded-[18px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-ink-subtle" aria-hidden />
        <span className="text-[13px] font-medium text-ink-muted">{label}</span>
      </div>
      <p
        className={cn(
          'mt-3 font-display font-bold leading-none',
          muted ? 'text-lg text-ink-subtle' : 'tabular text-[30px] tracking-[-0.8px] text-ink',
        )}
      >
        {value}
      </p>
      <p className="mt-2 text-xs text-ink-subtle">{sub}</p>
    </div>
  );
}

/**
 * Cruce de la ÚLTIMA corrida: DB neto = Extracto proveedor → discrepancia (verde dentro de umbral, rojo si
 * alertó). Excepción honesta: si el proveedor no expuso extracto (`isStatementMissing`), NO hay discrepancia
 * real que reportar → panel neutral "Sin extracto" en vez de un 100% rojo engañoso.
 */
function CompareRow({ run }: { run: ReconciliationRunView }) {
  const missing = isStatementMissing(run);
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
      <CompareCard
        icon={Database}
        label="DB · neto capturado"
        value={money(run.dbTotalCents)}
        sub="net_settled − refunds (COALESCE por fila)"
      />
      <div className="flex items-center justify-center lg:w-10">
        <Equal className="size-5 text-ink-subtle" aria-hidden />
      </div>
      <CompareCard
        icon={FileText}
        label="Extracto proveedor"
        value={missing ? 'Sin extracto' : money(run.statementTotalCents)}
        sub={missing ? 'ProntoPaga aún no expone el extracto del período' : 'Yape/Plin · statement del período'}
        muted={missing}
      />
      {missing ? (
        <div className="flex flex-col justify-center gap-1.5 rounded-[18px] border border-border bg-surface-2 p-[22px] text-center shadow-3 lg:w-72">
          <span className="font-display text-lg font-bold text-ink-muted">Sin extracto</span>
          <span className="text-xs font-medium text-ink-subtle">
            Conciliación por DB/webhooks — el proveedor aún no expone el extracto para cruzar.
          </span>
        </div>
      ) : (
        <div
          className={cn(
            'flex flex-col justify-center gap-1 rounded-[18px] border p-[22px] text-center shadow-3 lg:w-72',
            run.alerted ? 'border-danger bg-danger/12' : 'border-success bg-success/12',
          )}
        >
          <span
            className={cn(
              'font-display text-2xl font-bold',
              run.alerted ? 'text-danger' : 'text-success',
            )}
          >
            {pct(run.discrepancyPct)}
          </span>
          <span
            className={cn('text-xs font-semibold', run.alerted ? 'text-danger' : 'text-success')}
          >
            {run.alerted ? 'Discrepancia · SOBRE umbral' : 'Discrepancia · dentro de umbral'}
          </span>
        </div>
      )}
    </div>
  );
}

// Historial: una fila por corrida del cron. `alerted` (columna propia del ReconciliationRun) decide el estado;
// los montos y conteos viven en el `details` que el bff aplanó. Discrepancia como % (0..1 → 2 decimales).
const columns: ColumnDef<ReconciliationRunView, unknown>[] = [
  {
    accessorKey: 'ranAt',
    header: 'Fecha',
    cell: ({ row }) => <span className="text-ink">{fmtDate(row.original.ranAt)}</span>,
  },
  {
    accessorKey: 'dbTotalCents',
    header: 'DB (capturado)',
    cell: ({ row }) => (
      <span className="tabular text-ink-muted">{money(row.original.dbTotalCents)}</span>
    ),
  },
  {
    accessorKey: 'statementTotalCents',
    header: 'Extracto',
    cell: ({ row }) =>
      isStatementMissing(row.original) ? (
        <span className="text-ink-subtle">Sin extracto</span>
      ) : (
        <span className="tabular text-ink-muted">{money(row.original.statementTotalCents)}</span>
      ),
  },
  {
    accessorKey: 'discrepancyPct',
    header: 'Discrepancia',
    // Sin extracto no hay discrepancia real → guion neutral, NO el 100% engañoso.
    cell: ({ row }) =>
      isStatementMissing(row.original) ? (
        <span className="text-ink-subtle">—</span>
      ) : (
        <span className={cn('tabular', row.original.alerted ? 'text-danger' : 'text-ink-muted')}>
          {pct(row.original.discrepancyPct)}
        </span>
      ),
  },
  {
    accessorKey: 'alerted',
    header: 'Estado',
    cell: ({ row }) => {
      if (isStatementMissing(row.original)) return <Badge tone="neutral">Sin extracto</Badge>;
      return (
        <Badge tone={row.original.alerted ? 'danger' : 'success'}>
          {row.original.alerted ? 'Alerta' : 'Conciliado'}
        </Badge>
      );
    },
  },
];

export default function ReconciliationPage() {
  const user = useSession();
  const requestAccess = useRequestAccess();
  const query = useReconciliation();

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Reconciliación"
          breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reconciliación' }]}
        />
        <PermissionState
          className="flex-1"
          section="Reconciliación"
          permission="finance:view"
          onRequest={() => requestAccess('finance:view')}
        />
      </div>
    );
  }

  const runs = query.data?.pages.flatMap((p) => p.items) ?? [];
  const latest = runs[0];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Reconciliación"
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reconciliación' }]}
      />
      <div className="stagger min-h-0 flex-1 space-y-5 overflow-auto px-4 pb-6 pt-4 lg:px-6">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <div className="space-y-5">
            <Skeleton className="h-32" />
            <Skeleton className="h-64" />
          </div>
        ) : runs.length === 0 ? (
          <EmptyState
            icon={<Scale className="size-6" aria-hidden />}
            title="Sin corridas de conciliación"
            description="Todavía no corrió el cron de conciliación (04:00 diario) o no hay cobros Yape/Plin en el período."
          />
        ) : (
          <>
            {latest ? <CompareRow run={latest} /> : null}
            <DataTable
              caption="Historial de conciliación"
              columns={columns}
              data={runs}
              emptyTitle="Sin corridas"
              emptyDescription="No hay corridas de conciliación registradas."
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
  );
}
