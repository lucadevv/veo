'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useDrivers, useDriversPending } from '@/lib/api/queries';
import type { DriverApproval, PendingDriver } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { Lock } from 'lucide-react';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PendingDriverActions } from '@/components/drivers/pending-driver-actions';
import { RejectedDriverActions } from '@/components/drivers/rejected-driver-actions';
import { ActiveDriverActions } from '@/components/drivers/active-driver-actions';

/** Columnas de la flota verificada (ACTIVE/ALL · read-model). Acción de SAFETY: suspender (aprobar/rechazar es del tab Pendientes). */
const columns: ColumnDef<DriverApproval, unknown>[] = [
  {
    accessorKey: 'fullName',
    header: 'Conductor',
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="text-ink">{row.original.fullName ?? '—'}</span>
        <span className="font-mono text-xs text-ink-muted">{row.original.id.slice(0, 8)}</span>
      </div>
    ),
  },
  {
    accessorKey: 'phone',
    header: 'Teléfono',
    cell: ({ row }) => <span className="tabular text-ink-muted">{row.original.phone ?? '—'}</span>,
  },
  {
    accessorKey: 'status',
    header: 'Estado',
    cell: ({ row }) => <StatusPill status={row.original.status} />,
  },
  {
    accessorKey: 'averageRating',
    header: 'Rating',
    cell: ({ row }) => (
      <span className="tabular">
        {row.original.averageRating !== null ? row.original.averageRating.toFixed(2) : '—'}
      </span>
    ),
  },
  {
    accessorKey: 'backgroundCheckStatus',
    header: 'Antecedentes',
    cell: ({ row }) => <StatusPill status={row.original.backgroundCheckStatus} />,
  },
  {
    accessorKey: 'submittedAt',
    header: 'Enviado',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.submittedAt)}</span>,
  },
  {
    id: 'actions',
    header: 'Acciones',
    enableSorting: false,
    cell: ({ row }) => <ActiveDriverActions driver={row.original} />,
  },
];

/** Columnas de la COLA de pendientes de aprobación (identity pending-approval). */
const pendingColumns: ColumnDef<PendingDriver, unknown>[] = [
  {
    accessorKey: 'id',
    header: 'Conductor',
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-mono text-xs text-ink">{row.original.id.slice(0, 8)}</span>
        <span className="font-mono text-xs text-ink-muted">
          usuario {row.original.userId.slice(0, 8)}
        </span>
      </div>
    ),
  },
  {
    accessorKey: 'licenseNumber',
    header: 'Licencia',
    cell: ({ row }) => (
      <span className="tabular text-ink-muted">{row.original.licenseNumber ?? '—'}</span>
    ),
  },
  {
    id: 'actions',
    header: 'Acciones',
    enableSorting: false,
    cell: ({ row }) => <PendingDriverActions driver={row.original} />,
  },
];

/** Columnas de la cola de RECHAZADOS: muestra el motivo + permite re-aprobar (cierra el dead-end). */
const rejectedColumns: ColumnDef<DriverApproval, unknown>[] = [
  {
    accessorKey: 'fullName',
    header: 'Conductor',
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="text-ink">{row.original.fullName ?? '—'}</span>
        <span className="font-mono text-xs text-ink-muted">{row.original.id.slice(0, 8)}</span>
      </div>
    ),
  },
  {
    accessorKey: 'rejectionReason',
    header: 'Motivo del rechazo',
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-ink-muted">
        {row.original.rejectionReason ?? <span className="italic">Sin motivo registrado</span>}
      </span>
    ),
  },
  {
    accessorKey: 'submittedAt',
    header: 'Rechazado',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.submittedAt)}</span>,
  },
  {
    id: 'actions',
    header: 'Acciones',
    enableSorting: false,
    cell: ({ row }) => <RejectedDriverActions driver={row.original} />,
  },
];

export default function DriversPage() {
  const user = useSession();
  const [tab, setTab] = useState('PENDING');
  // La cola de pendientes viene de identity (pending-approval), NO del read-model (que solo tiene ACTIVE/SUSPENDED).
  const pending = useDriversPending();
  // El read-model sirve la flota verificada (ACTIVE) y el listado completo (ALL), paginado por cursor.
  const fleet = useDrivers(tab === 'PENDING' ? 'ACTIVE' : tab);
  const fleetRows = fleet.data?.pages.flatMap((p) => p.items) ?? [];

  if (!can(user, 'drivers:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Conductores"
          breadcrumbs={[{ label: 'Operación' }, { label: 'Conductores' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol correspondiente para ver los conductores."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Conductores"
        description="Aprobación de altas y estado de la flota de conductores."
        breadcrumbs={[{ label: 'Operación' }, { label: 'Conductores' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <Tabs value={tab} onValueChange={setTab} className="pt-4">
          <TabsList>
            <TabsTrigger value="PENDING">Pendientes</TabsTrigger>
            <TabsTrigger value="ACTIVE">Activos</TabsTrigger>
            <TabsTrigger value="REJECTED">Rechazados</TabsTrigger>
            <TabsTrigger value="ALL">Todos</TabsTrigger>
          </TabsList>

          <TabsContent value="PENDING">
            {pending.isError ? (
              <ErrorState onRetry={() => void pending.refetch()} />
            ) : (
              <DataTable
                caption="Conductores pendientes de aprobación"
                columns={pendingColumns}
                data={pending.data ?? []}
                loading={pending.isLoading}
                emptyTitle="Sin conductores pendientes"
                emptyDescription="No hay altas de conductores esperando aprobación de antecedentes."
              />
            )}
          </TabsContent>

          {(['ACTIVE', 'REJECTED', 'ALL'] as const).map((value) => (
            <TabsContent key={value} value={value}>
              {fleet.isError ? (
                <ErrorState onRetry={() => void fleet.refetch()} />
              ) : (
                <>
                  <DataTable
                    caption={
                      value === 'REJECTED' ? 'Conductores rechazados' : 'Listado de conductores'
                    }
                    columns={value === 'REJECTED' ? rejectedColumns : columns}
                    data={fleetRows}
                    loading={fleet.isLoading}
                    emptyTitle={
                      value === 'REJECTED' ? 'Sin conductores rechazados' : 'Sin conductores'
                    }
                    emptyDescription={
                      value === 'REJECTED'
                        ? 'No hay conductores con antecedentes rechazados.'
                        : 'No hay conductores en esta vista.'
                    }
                  />
                  <LoadMore
                    hasNextPage={!!fleet.hasNextPage}
                    isFetching={fleet.isFetchingNextPage}
                    onLoadMore={() => void fleet.fetchNextPage()}
                  />
                </>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
