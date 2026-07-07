'use client';

import type { LucideIcon } from 'lucide-react';
import { Lock, Equal, Scale, Database, FileText } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { useReconciliation } from '@/lib/api/queries';
import type { ReconciliationRunView } from '@/lib/api/schemas';
import { money } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadMore } from '@/components/ui/load-more';

/** Discrepancia 0..1 → porcentaje con 2 decimales. */
function pct(p: number): string {
  return `${(p * 100).toFixed(2)} %`;
}

const DATE_FMT = new Intl.DateTimeFormat('es-PE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
function fmtDate(iso: string): string {
  return DATE_FMT.format(new Date(iso));
}

/** Una card del cruce (DB o Extracto): icono + label · valor grande · sub. */
function CompareCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="flex-1 rounded-lg border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-ink-subtle" aria-hidden />
        <span className="text-xs font-medium text-ink-muted">{label}</span>
      </div>
      <p className="tabular mt-2 font-display text-2xl font-bold text-ink">{value}</p>
      <p className="mt-1 text-xs text-ink-subtle">{sub}</p>
    </div>
  );
}

/** Cruce de la ÚLTIMA corrida: DB neto = Extracto proveedor → discrepancia (verde dentro de umbral, rojo si alertó). */
function CompareRow({ run }: { run: ReconciliationRunView }) {
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
        value={money(run.statementTotalCents)}
        sub="Yape/Plin · statement del período"
      />
      <div
        className={cn(
          'flex flex-col justify-center gap-1 rounded-lg border p-5 text-center lg:w-72',
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
        <span className={cn('text-xs font-semibold', run.alerted ? 'text-danger' : 'text-success')}>
          {run.alerted ? 'Discrepancia · SOBRE umbral' : 'Discrepancia · dentro de umbral'}
        </span>
      </div>
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
    cell: ({ row }) => (
      <span className="tabular text-ink-muted">{money(row.original.statementTotalCents)}</span>
    ),
  },
  {
    accessorKey: 'discrepancyPct',
    header: 'Discrepancia',
    cell: ({ row }) => (
      <span className={cn('tabular', row.original.alerted ? 'text-danger' : 'text-ink-muted')}>
        {pct(row.original.discrepancyPct)}
      </span>
    ),
  },
  {
    accessorKey: 'alerted',
    header: 'Estado',
    cell: ({ row }) => (
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-xs font-medium',
          row.original.alerted ? 'bg-danger/12 text-danger' : 'bg-success/12 text-success',
        )}
      >
        {row.original.alerted ? 'Alerta' : 'Conciliado'}
      </span>
    ),
  },
];

export default function ReconciliationPage() {
  const user = useSession();
  const query = useReconciliation();

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Reconciliación"
          breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reconciliación' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE o ADMIN para ver la reconciliación."
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
        description="Cruce diario (BR-P07): el neto capturado en la DB (Yape/Plin) contra el extracto del proveedor."
        breadcrumbs={[{ label: 'Finanzas' }, { label: 'Reconciliación' }]}
      />
      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-4 pb-6 pt-4 lg:px-6">
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
