'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { usePanics } from '@/lib/api/queries';
import type { PanicSummary } from '@/lib/api/schemas';
import { dateTime, relativeFromNow } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { ErrorState } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const columns: ColumnDef<PanicSummary, unknown>[] = [
  {
    accessorKey: 'triggeredAt',
    header: 'Disparado',
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-danger" aria-hidden />
        <span className="text-ink">{relativeFromNow(row.original.triggeredAt)}</span>
      </div>
    ),
  },
  {
    accessorKey: 'tripId',
    header: 'Viaje',
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.tripId.slice(0, 8)}</span>,
  },
  {
    accessorKey: 'passengerId',
    header: 'Pasajero',
    cell: ({ row }) => (
      <span className="font-mono text-xs text-ink-muted">{row.original.passengerId.slice(0, 8)}</span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Estado',
    cell: ({ row }) => <StatusPill status={row.original.status} />,
  },
  {
    accessorKey: 'acknowledgedAt',
    header: 'Reconocido',
    cell: ({ row }) => (
      <span className="text-ink-muted">{dateTime(row.original.acknowledgedAt)}</span>
    ),
  },
];

export default function PanicsPage() {
  const router = useRouter();
  const [tab, setTab] = useState('OPEN');
  const query = usePanics(tab);
  const rows = query.data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Alertas de pánico"
        description="Atención y resolución de incidentes de seguridad."
        breadcrumbs={[{ label: 'Seguridad' }, { label: 'Pánicos' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <Tabs value={tab} onValueChange={setTab} className="pt-4">
          <TabsList>
            <TabsTrigger value="OPEN">Abiertos</TabsTrigger>
            <TabsTrigger value="ACKNOWLEDGED">Reconocidos</TabsTrigger>
            <TabsTrigger value="ALL">Todos</TabsTrigger>
          </TabsList>
          <TabsContent value={tab}>
            {query.isError ? (
              <ErrorState onRetry={() => void query.refetch()} />
            ) : (
              <DataTable
                caption="Listado de alertas de pánico"
                columns={columns}
                data={rows}
                loading={query.isLoading}
                emptyTitle="Sin alertas"
                emptyDescription="No hay alertas en esta vista."
                onRowClick={(row) => router.push(`/security/panics/${row.id}`)}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
