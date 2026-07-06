'use client';

import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  ClipboardList,
  Eye,
  Lock,
  Users,
} from 'lucide-react';
import {
  useDriversPending,
  useExpiringDocuments,
  useFleetDocuments,
  useModelReview,
  useReviewsSummary,
} from '@/lib/api/queries';
import type {
  ExpiringDocumentView,
  FleetDocumentView,
  PendingDriver,
  VehicleModelReviewView,
} from '@/lib/api/schemas';
import { date } from '@/lib/formatters';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DocumentActions } from '@/components/fleet/document-actions';
import { ModelReviewActions } from '@/components/fleet/model-review-actions';
import { PendingDriverActions } from '@/components/drivers/pending-driver-actions';

const OWNER_LABEL: Record<'DRIVER' | 'VEHICLE', string> = {
  DRIVER: 'Conductor',
  VEHICLE: 'Vehículo',
};
const VEHICLE_TYPE_LABEL: Record<string, string> = { CAR: 'Auto', MOTO: 'Moto' };

/** Badge de conteo para las pestañas de la cola (número REAL del summary; 0 → neutro, >0 → destaca). */
function TabCount({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return (
    <span
      className={cn(
        'ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular',
        n > 0 ? 'bg-brand/15 text-brand' : 'bg-surface-2 text-ink-subtle',
      )}
    >
      {n}
    </span>
  );
}

/** Link de drill-down al detalle del conductor (donde vive la revisión completa: docs + biométrico). */
function ReviewLink({ id }: { id: string }) {
  return (
    <Link
      href={`/ops/drivers/${id}`}
      className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-2"
    >
      <Eye className="size-4" aria-hidden />
      Revisar
    </Link>
  );
}

/** Cola de conductores pendientes de aprobación (identity). Acción: aprobar/rechazar (MFA) + drill-down. */
const driverColumns: ColumnDef<PendingDriver, unknown>[] = [
  {
    accessorKey: 'fullName',
    header: 'Conductor',
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        <Avatar name={row.original.fullName} size="sm" />
        <div className="flex flex-col">
          <span className="text-ink">{row.original.fullName ?? 'Sin nombre'}</span>
          <span className="font-mono text-xs text-ink-muted">{row.original.id.slice(0, 8)}</span>
        </div>
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
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <ReviewLink id={row.original.id} />
        <PendingDriverActions driver={row.original} />
      </div>
    ),
  },
];

/** Cola de documentos de flota por revisar (FleetDocument PENDING_REVIEW). Acción: aprobar/rechazar el doc. */
const documentColumns: ColumnDef<FleetDocumentView, unknown>[] = [
  {
    accessorKey: 'type',
    header: 'Documento',
    cell: ({ row }) => <span className="text-ink">{row.original.type}</span>,
  },
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
    accessorKey: 'status',
    header: 'Estado',
    cell: ({ row }) => <StatusPill status={row.original.status} />,
  },
  {
    id: 'actions',
    header: 'Acciones',
    enableSorting: false,
    cell: ({ row }) => <DocumentActions doc={row.original} />,
  },
];

/** Cola de modelos de vehículo por curar (VehicleModelSpec PENDING_REVIEW). Acción: aprobar la ficha. */
const modelColumns: ColumnDef<VehicleModelReviewView, unknown>[] = [
  {
    accessorKey: 'make',
    header: 'Modelo',
    cell: ({ row }) => (
      <span className="text-ink">
        {row.original.make} {row.original.model}
      </span>
    ),
  },
  {
    id: 'years',
    header: 'Años',
    cell: ({ row }) => (
      <span className="tabular text-ink-muted">
        {row.original.yearFrom}–{row.original.yearTo}
      </span>
    ),
  },
  {
    accessorKey: 'vehicleType',
    header: 'Tipo',
    cell: ({ row }) => (
      <span className="text-ink-muted">
        {VEHICLE_TYPE_LABEL[row.original.vehicleType] ?? row.original.vehicleType} ·{' '}
        {row.original.seats} as.
      </span>
    ),
  },
  {
    accessorKey: 'requestedBy',
    header: 'Solicitó',
    cell: ({ row }) => (
      <span className="font-mono text-ink-muted">{row.original.requestedBy?.slice(0, 8) ?? '—'}</span>
    ),
  },
  {
    id: 'actions',
    header: 'Acciones',
    enableSorting: false,
    cell: ({ row }) => <ModelReviewActions model={row.original} />,
  },
];

/** Cola de vencimientos próximos (documentos por vencer). Seguimiento; el urgente (≤7 d) se marca en danger. */
const expiringColumns: ColumnDef<ExpiringDocumentView, unknown>[] = [
  {
    accessorKey: 'type',
    header: 'Documento',
    cell: ({ row }) => <span className="text-ink">{row.original.type}</span>,
  },
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
    cell: ({ row }) => <span className="text-ink-muted">{date(row.original.expiresAt)}</span>,
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
            'inline-flex items-center gap-1.5 font-medium tabular',
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

/**
 * Revisiones — la COLA UNIFICADA de todo lo que espera revisión del operador de flota, en una sola pantalla:
 * conductores pendientes de aprobación (identity), documentos de flota por revisar, modelos de vehículo por
 * curar y vencimientos próximos (fleet). Los stat cards traen los conteos REALES agregados (useReviewsSummary,
 * que fusiona identity + fleet); cada pestaña sirve la cola viva con su acción in-situ (aprobar/rechazar/curar),
 * reutilizando los componentes de acción canónicos. Gateada por `fleet:review`; el bff revalida server-side.
 */
export default function ReviewsPage() {
  const user = useSession();
  const summary = useReviewsSummary();
  const drivers = useDriversPending();
  const documents = useFleetDocuments('PENDING_REVIEW');
  const models = useModelReview('PENDING_REVIEW');
  const expiring = useExpiringDocuments();

  const breadcrumbs = [{ label: 'Flota' }, { label: 'Revisiones' }];

  if (!can(user, 'fleet:review')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Revisiones" breadcrumbs={breadcrumbs} />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol de revisión de flota para ver la cola de revisiones."
        />
      </div>
    );
  }

  const counts = summary.data;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Revisiones"
        description="Cola unificada de aprobaciones y vencimientos: conductores, documentos y modelos."
        breadcrumbs={breadcrumbs}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <div className="pt-4">
          <StatCardGrid>
            <StatCard
              icon={Users}
              label="Conductores"
              value={String(counts?.driversPending ?? 0)}
              hint="Pendientes de aprobación"
              hintTone="warn"
              loading={summary.isLoading}
            />
            <StatCard
              icon={ClipboardList}
              label="Documentos"
              value={String(counts?.docsPendingReview ?? 0)}
              hint="Por revisar"
              hintTone="warn"
              loading={summary.isLoading}
            />
            <StatCard
              icon={BadgeCheck}
              label="Modelos"
              value={String(counts?.modelsPendingReview ?? 0)}
              hint="Por curar"
              hintTone="brand"
              loading={summary.isLoading}
            />
            <StatCard
              icon={CalendarClock}
              label="Vencimientos"
              value={String(counts?.docsExpiringSoon ?? 0)}
              hint="Documentos por vencer"
              hintTone="danger"
              loading={summary.isLoading}
            />
          </StatCardGrid>
        </div>

        <Tabs defaultValue="drivers" className="pt-5">
          <TabsList>
            <TabsTrigger value="drivers">
              Conductores
              <TabCount n={counts?.driversPending} />
            </TabsTrigger>
            <TabsTrigger value="documents">
              Documentos
              <TabCount n={counts?.docsPendingReview} />
            </TabsTrigger>
            <TabsTrigger value="models">
              Modelos
              <TabCount n={counts?.modelsPendingReview} />
            </TabsTrigger>
            <TabsTrigger value="expiring">
              Vencimientos
              <TabCount n={counts?.docsExpiringSoon} />
            </TabsTrigger>
          </TabsList>

          <TabsContent value="drivers">
            {drivers.isError ? (
              <ErrorState onRetry={() => void drivers.refetch()} />
            ) : (
              <DataTable
                caption="Conductores pendientes de aprobación"
                columns={driverColumns}
                data={drivers.data ?? []}
                loading={drivers.isLoading}
                emptyTitle="Sin conductores pendientes"
                emptyDescription="No hay altas de conductores esperando aprobación."
              />
            )}
          </TabsContent>

          <TabsContent value="documents">
            {documents.isError ? (
              <ErrorState onRetry={() => void documents.refetch()} />
            ) : (
              <>
                <DataTable
                  caption="Documentos de flota por revisar"
                  columns={documentColumns}
                  data={documents.data?.pages.flatMap((p) => p.items) ?? []}
                  loading={documents.isLoading}
                  emptyTitle="Sin documentos pendientes"
                  emptyDescription="No hay documentos de flota esperando revisión."
                />
                <LoadMore
                  hasNextPage={!!documents.hasNextPage}
                  isFetching={documents.isFetchingNextPage}
                  onLoadMore={() => void documents.fetchNextPage()}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="models">
            {models.isError ? (
              <ErrorState onRetry={() => void models.refetch()} />
            ) : (
              <>
                <DataTable
                  caption="Modelos de vehículo por curar"
                  columns={modelColumns}
                  data={models.data?.pages.flatMap((p) => p.items) ?? []}
                  loading={models.isLoading}
                  emptyTitle="Sin modelos pendientes"
                  emptyDescription="Cuando un conductor solicite un modelo fuera del catálogo, aparecerá acá."
                />
                <LoadMore
                  hasNextPage={!!models.hasNextPage}
                  isFetching={models.isFetchingNextPage}
                  onLoadMore={() => void models.fetchNextPage()}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="expiring">
            {expiring.isError ? (
              <ErrorState onRetry={() => void expiring.refetch()} />
            ) : (
              <>
                <DataTable
                  caption="Documentos por vencer"
                  columns={expiringColumns}
                  data={expiring.data?.pages.flatMap((p) => p.items) ?? []}
                  loading={expiring.isLoading}
                  emptyTitle="Sin vencimientos próximos"
                  emptyDescription="Ningún documento vence pronto."
                />
                <LoadMore
                  hasNextPage={!!expiring.hasNextPage}
                  isFetching={expiring.isFetchingNextPage}
                  onLoadMore={() => void expiring.fetchNextPage()}
                />
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
