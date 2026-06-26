'use client';

import { useState } from 'react';
import { Lock } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { usePayouts } from '@/lib/api/queries';
import { payoutStatus, type PayoutView } from '@/lib/api/schemas';
import { money, dateTime } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ReleaseHeldPayoutButton,
  RetryPayoutButton,
  RunPayoutsButton,
} from '@/components/finance/payout-actions';
import { RefundDialog } from '@/components/finance/refund-dialog';

const columns: ColumnDef<PayoutView, unknown>[] = [
  {
    accessorKey: 'id',
    header: 'Liquidación',
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.id.slice(0, 8)}</span>,
  },
  {
    accessorKey: 'driverId',
    header: 'Conductor',
    cell: ({ row }) => (
      <span className="font-mono text-xs text-ink-muted">{row.original.driverId.slice(0, 8)}</span>
    ),
  },
  {
    accessorKey: 'period',
    header: 'Periodo',
    cell: ({ row }) => <span className="text-ink-muted">{row.original.period}</span>,
  },
  // Desglose del payout (ADR-015 D6): Bruto / Comisión / Neto. Mismo formateador de plata (money, céntimos→S/)
  // y mismo patrón monetario que la columna anterior; bruto/comisión en text-ink-muted (contexto auditable),
  // el NETO en text-ink (el dato protagonista: lo que el conductor cobra). Alineadas a la derecha (tabular).
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
      <span className="tabular text-ink-muted">{money(row.original.commissionCents)}</span>
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
    // El estado, y SOLO en HELD, el motivo de retención como subtítulo discreto (sin recargar): heldReason
    // solo está poblado en HELD (contrato). Texto pequeño y atenuado bajo el pill, no un badge extra.
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
    accessorKey: 'processedAt',
    header: 'Procesado',
    // Cuándo el riel confirmó la salida (PROCESSED). dateTime() ya devuelve "—" si es null (no procesado aún).
    cell: ({ row }) => (
      <span className="tabular text-ink-muted">{dateTime(row.original.processedAt)}</span>
    ),
  },
  {
    id: 'actions',
    header: '',
    // Acción que REFLEJA el estado: una fila HELD ofrece liberar la retención del conductor (camino de vuelta
    // de driver.flagged); una fila FAILED ofrece reintentar el desembolso (ADR-015 §5). Ambos botones se
    // auto-ocultan sin permiso finance:payout. `status` es el enum tipado del contrato (payoutStatus): nada
    // de literales sueltos.
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
      return null;
    },
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
            <TabsTrigger value={payoutStatus.enum.FAILED}>Fallidas</TabsTrigger>
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
                  emptyDescription="No hay liquidaciones para el período seleccionado."
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
