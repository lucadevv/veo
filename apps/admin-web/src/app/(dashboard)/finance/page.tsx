'use client';

import { useState } from 'react';
import { Lock } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { usePayouts } from '@/lib/api/queries';
import { payoutStatus, type PayoutView } from '@/lib/api/schemas';
import { money } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ReleaseHeldPayoutButton, RunPayoutsButton } from '@/components/finance/payout-actions';
import { RefundDialog } from '@/components/finance/refund-dialog';

const columns: ColumnDef<PayoutView, unknown>[] = [
  { accessorKey: 'id', header: 'Liquidación', cell: ({ row }) => <span className="font-mono text-xs">{row.original.id.slice(0, 8)}</span> },
  {
    accessorKey: 'driverId',
    header: 'Conductor',
    cell: ({ row }) => <span className="font-mono text-xs text-ink-muted">{row.original.driverId.slice(0, 8)}</span>,
  },
  { accessorKey: 'period', header: 'Periodo', cell: ({ row }) => <span className="text-ink-muted">{row.original.period}</span> },
  {
    accessorKey: 'amountCents',
    header: 'Monto',
    cell: ({ row }) => <span className="tabular font-medium text-ink">{money(row.original.amountCents)}</span>,
  },
  { accessorKey: 'status', header: 'Estado', cell: ({ row }) => <StatusPill status={row.original.status} /> },
  {
    id: 'actions',
    header: '',
    // Acción que REFLEJA el estado: solo una fila HELD ofrece liberar la retención del conductor
    // (camino de vuelta de driver.flagged). El botón se auto-oculta sin permiso finance:payout.
    // `status` es el enum tipado del contrato (payoutStatus): nada de literales sueltos.
    cell: ({ row }) =>
      row.original.status === payoutStatus.enum.HELD ? (
        <ReleaseHeldPayoutButton driverId={row.original.driverId} amountCents={row.original.amountCents} />
      ) : null,
  },
];

export default function FinancePage() {
  const user = useSession();
  const [tab, setTab] = useState('PENDING');
  const query = usePayouts(tab);

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Finanzas" breadcrumbs={[{ label: 'Finanzas' }]} />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol FINANCE para ver liquidaciones y reembolsos."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Liquidaciones"
        description="Pagos a conductores y reembolsos a pasajeros."
        breadcrumbs={[{ label: 'Finanzas' }]}
        actions={
          <div className="flex items-center gap-2">
            {can(user, 'finance:payout') ? <RunPayoutsButton /> : null}
            {can(user, 'finance:refund') ? <RefundDialog /> : null}
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <Tabs value={tab} onValueChange={setTab} className="pt-4">
          <TabsList>
            <TabsTrigger value="PENDING">Pendientes</TabsTrigger>
            <TabsTrigger value="HELD">Retenidas</TabsTrigger>
            <TabsTrigger value="PROCESSED">Procesadas</TabsTrigger>
            <TabsTrigger value="ALL">Todas</TabsTrigger>
          </TabsList>
          <TabsContent value={tab}>
            {query.isError ? (
              <ErrorState onRetry={() => void query.refetch()} />
            ) : (
              <>
                <DataTable
                  caption="Liquidaciones"
                  columns={columns}
                  data={query.data?.pages.flatMap((p) => p.items) ?? []}
                  loading={query.isLoading}
                  emptyTitle="Sin liquidaciones"
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
