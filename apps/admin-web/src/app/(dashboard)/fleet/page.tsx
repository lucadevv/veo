'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle } from 'lucide-react';
import {
  useExpiringDocuments,
  useFleetDocuments,
  useInspections,
  useVehicles,
} from '@/lib/api/queries';
import type {
  ExpiringDocumentView,
  FleetDocumentView,
  InspectionView,
  VehicleView,
} from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { ErrorState } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DocumentActions } from '@/components/fleet/document-actions';

const OWNER_LABEL: Record<'DRIVER' | 'VEHICLE', string> = {
  DRIVER: 'Conductor',
  VEHICLE: 'Vehículo',
};

const documentColumns: ColumnDef<FleetDocumentView, unknown>[] = [
  { accessorKey: 'type', header: 'Tipo', cell: ({ row }) => <span className="text-ink">{row.original.type}</span> },
  {
    accessorKey: 'ownerType',
    header: 'Titular',
    cell: ({ row }) => (
      <span className="text-ink-muted">
        {OWNER_LABEL[row.original.ownerType]} · {row.original.ownerId.slice(0, 8)}
      </span>
    ),
  },
  { accessorKey: 'status', header: 'Estado', cell: ({ row }) => <StatusPill status={row.original.status} /> },
  {
    accessorKey: 'expiresAt',
    header: 'Vence',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.expiresAt)}</span>,
  },
  { id: 'actions', header: 'Acciones', enableSorting: false, cell: ({ row }) => <DocumentActions doc={row.original} /> },
];

const vehicleColumns: ColumnDef<VehicleView, unknown>[] = [
  { accessorKey: 'plate', header: 'Placa', cell: ({ row }) => <span className="font-mono tabular">{row.original.plate}</span> },
  {
    accessorKey: 'model',
    header: 'Vehículo',
    cell: ({ row }) => (
      <span className="text-ink">
        {[row.original.brand, row.original.model].filter(Boolean).join(' ') || '—'}
        {row.original.year ? ` (${row.original.year})` : ''}
      </span>
    ),
  },
  { accessorKey: 'color', header: 'Color', cell: ({ row }) => <span className="text-ink-muted">{row.original.color ?? '—'}</span> },
  { accessorKey: 'status', header: 'Estado', cell: ({ row }) => <StatusPill status={row.original.status} /> },
  {
    accessorKey: 'driverId',
    header: 'Conductor',
    cell: ({ row }) => (
      <span className="font-mono text-xs text-ink-muted">
        {row.original.driverId ? row.original.driverId.slice(0, 8) : '—'}
      </span>
    ),
  },
];

const inspectionColumns: ColumnDef<InspectionView, unknown>[] = [
  {
    accessorKey: 'vehicleId',
    header: 'Vehículo',
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.vehicleId.slice(0, 8)}</span>,
  },
  { accessorKey: 'status', header: 'Estado', cell: ({ row }) => <StatusPill status={row.original.status} /> },
  {
    accessorKey: 'scheduledAt',
    header: 'Programada',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.scheduledAt)}</span>,
  },
  {
    accessorKey: 'inspectedAt',
    header: 'Realizada',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.inspectedAt)}</span>,
  },
  { accessorKey: 'inspector', header: 'Inspector', cell: ({ row }) => <span className="text-ink-muted">{row.original.inspector ?? '—'}</span> },
  { accessorKey: 'result', header: 'Resultado', cell: ({ row }) => (row.original.result ? <StatusPill status={row.original.result} /> : <span className="text-ink-subtle">—</span>) },
];

const expiringColumns: ColumnDef<ExpiringDocumentView, unknown>[] = [
  { accessorKey: 'type', header: 'Tipo', cell: ({ row }) => <span className="text-ink">{row.original.type}</span> },
  {
    accessorKey: 'ownerType',
    header: 'Titular',
    cell: ({ row }) => (
      <span className="text-ink-muted">
        {OWNER_LABEL[row.original.ownerType]} · {row.original.ownerId.slice(0, 8)}
      </span>
    ),
  },
  {
    accessorKey: 'expiresAt',
    header: 'Vence',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.expiresAt)}</span>,
  },
  {
    accessorKey: 'daysUntilExpiry',
    header: 'Días restantes',
    cell: ({ row }) => {
      const days = row.original.daysUntilExpiry;
      const urgent = days <= 7;
      return (
        <span
          className={cn(
            'inline-flex items-center gap-1.5 tabular font-medium',
            urgent ? 'text-danger' : days <= 30 ? 'text-warn' : 'text-ink',
          )}
        >
          {urgent ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
          {days} d
        </span>
      );
    },
  },
];

export default function FleetPage() {
  const documents = useFleetDocuments('PENDING');
  const vehicles = useVehicles();
  const inspections = useInspections();
  const expiring = useExpiringDocuments();

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Flota"
        description="Documentos, vehículos, inspecciones y vencimientos próximos."
        breadcrumbs={[{ label: 'Flota' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <Tabs defaultValue="documents" className="pt-4">
          <TabsList>
            <TabsTrigger value="documents">Documentos</TabsTrigger>
            <TabsTrigger value="vehicles">Vehículos</TabsTrigger>
            <TabsTrigger value="inspections">Inspecciones</TabsTrigger>
            <TabsTrigger value="expiring">Vencimientos</TabsTrigger>
          </TabsList>

          <TabsContent value="documents">
            {documents.isError ? (
              <ErrorState onRetry={() => void documents.refetch()} />
            ) : (
              <DataTable
                caption="Documentos por revisar"
                columns={documentColumns}
                data={documents.data?.items ?? []}
                loading={documents.isLoading}
                emptyTitle="Sin documentos pendientes"
              />
            )}
          </TabsContent>

          <TabsContent value="vehicles">
            {vehicles.isError ? (
              <ErrorState onRetry={() => void vehicles.refetch()} />
            ) : (
              <DataTable
                caption="Vehículos de la flota"
                columns={vehicleColumns}
                data={vehicles.data?.items ?? []}
                loading={vehicles.isLoading}
                emptyTitle="Sin vehículos"
              />
            )}
          </TabsContent>

          <TabsContent value="inspections">
            {inspections.isError ? (
              <ErrorState onRetry={() => void inspections.refetch()} />
            ) : (
              <DataTable
                caption="Inspecciones"
                columns={inspectionColumns}
                data={inspections.data?.items ?? []}
                loading={inspections.isLoading}
                emptyTitle="Sin inspecciones"
              />
            )}
          </TabsContent>

          <TabsContent value="expiring">
            {expiring.isError ? (
              <ErrorState onRetry={() => void expiring.refetch()} />
            ) : (
              <DataTable
                caption="Documentos por vencer"
                columns={expiringColumns}
                data={expiring.data ?? []}
                loading={expiring.isLoading}
                emptyTitle="Sin vencimientos próximos"
                emptyDescription="Ningún documento vence pronto."
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
