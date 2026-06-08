'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useDrivers } from '@/lib/api/queries';
import type { DriverApproval } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { ErrorState } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DriverActions } from '@/components/drivers/driver-actions';

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
    cell: ({ row }) => (
      <span className="text-ink-muted">{dateTime(row.original.submittedAt)}</span>
    ),
  },
  {
    id: 'actions',
    header: 'Acciones',
    enableSorting: false,
    cell: ({ row }) => <DriverActions driver={row.original} />,
  },
];

export default function DriversPage() {
  const [tab, setTab] = useState('PENDING');
  const query = useDrivers(tab);
  const rows = query.data?.items ?? [];

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
            <TabsTrigger value="ALL">Todos</TabsTrigger>
          </TabsList>
          <TabsContent value={tab}>
            {query.isError ? (
              <ErrorState onRetry={() => void query.refetch()} />
            ) : (
              <DataTable
                caption="Listado de conductores"
                columns={columns}
                data={rows}
                loading={query.isLoading}
                emptyTitle="Sin conductores"
                emptyDescription="No hay conductores en esta vista."
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
