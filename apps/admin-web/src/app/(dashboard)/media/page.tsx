'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useMediaRequests } from '@/lib/api/queries';
import type { MediaAccessRequestView } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { ErrorState } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MediaActions } from '@/components/media/media-actions';
import { RequestAccessDialog } from '@/components/media/request-access-dialog';

const columns: ColumnDef<MediaAccessRequestView, unknown>[] = [
  { accessorKey: 'tripId', header: 'Viaje', cell: ({ row }) => <span className="font-mono text-xs">{row.original.tripId.slice(0, 8)}</span> },
  { accessorKey: 'reason', header: 'Motivo', cell: ({ row }) => <span className="text-ink">{row.original.reason}</span> },
  {
    accessorKey: 'requestedBy',
    header: 'Solicitante',
    cell: ({ row }) => <span className="font-mono text-xs text-ink-muted">{row.original.requestedBy.slice(0, 8)}</span>,
  },
  { accessorKey: 'status', header: 'Estado', cell: ({ row }) => <StatusPill status={row.original.status} /> },
  {
    accessorKey: 'requestedAt',
    header: 'Solicitado',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.requestedAt)}</span>,
  },
  { id: 'actions', header: 'Acciones', enableSorting: false, cell: ({ row }) => <MediaActions request={row.original} /> },
];

export default function MediaPage() {
  const user = useSession();
  const [tab, setTab] = useState('PENDING');
  const query = useMediaRequests(tab);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Acceso a video"
        description="Solicitud y aprobación de acceso a grabaciones (doble autenticación)."
        breadcrumbs={[{ label: 'Seguridad' }, { label: 'Video' }]}
        actions={can(user, 'media:request') ? <RequestAccessDialog /> : null}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <Tabs value={tab} onValueChange={setTab} className="pt-4">
          <TabsList>
            <TabsTrigger value="PENDING">Pendientes</TabsTrigger>
            <TabsTrigger value="APPROVED">Aprobadas</TabsTrigger>
            <TabsTrigger value="REJECTED">Rechazadas</TabsTrigger>
          </TabsList>
          <TabsContent value={tab}>
            {query.isError ? (
              <ErrorState onRetry={() => void query.refetch()} />
            ) : (
              <DataTable
                caption="Solicitudes de acceso a video"
                columns={columns}
                data={query.data?.items ?? []}
                loading={query.isLoading}
                emptyTitle="Sin solicitudes"
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
