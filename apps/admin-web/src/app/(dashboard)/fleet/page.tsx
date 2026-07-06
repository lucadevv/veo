'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, BadgeCheck, CalendarClock, FileWarning, Truck } from 'lucide-react';
import {
  useExpiringDocuments,
  useFleetDocuments,
  useInspections,
  useModelReview,
  useVehicles,
  useVehiclesSummary,
} from '@/lib/api/queries';
import type {
  ExpiringDocumentView,
  FleetDocumentView,
  InspectionView,
  VehicleModelReviewView,
  VehicleView,
} from '@/lib/api/schemas';
import { date, dateTime } from '@/lib/formatters';
import { segmentLabel, energyLabel, operabilityReasonLabel } from '@/lib/fleet-labels';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/table';
import { StatusPill } from '@/components/ui/status-pill';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { DocumentActions } from '@/components/fleet/document-actions';
import { ModelReviewActions } from '@/components/fleet/model-review-actions';
import {
  CreateDocumentDialog,
  CreateInspectionDialog,
  CreateVehicleDialog,
} from '@/components/fleet/fleet-forms';

const OWNER_LABEL: Record<'DRIVER' | 'VEHICLE', string> = {
  DRIVER: 'Conductor',
  VEHICLE: 'Vehículo',
};


const documentColumns: ColumnDef<FleetDocumentView, unknown>[] = [
  {
    accessorKey: 'type',
    header: 'Tipo',
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
    accessorKey: 'expiresAt',
    header: 'Vence',
    cell: ({ row }) => <span className="text-ink-muted">{date(row.original.expiresAt)}</span>,
  },
  {
    id: 'actions',
    header: 'Acciones',
    enableSorting: false,
    cell: ({ row }) => <DocumentActions doc={row.original} />,
  },
];

// Labels de la ficha técnica — ESPEJO EXACTO del formulario de aprobación de modelos
// (components/fleet/model-review-actions.tsx) para que el admin vea la MISMA terminología que eligió al
// aprobar. Son labels de presentación: el valor de dominio (el enum) viaja crudo y se mapea acá para mostrar.

const vehicleColumns: ColumnDef<VehicleView, unknown>[] = [
  {
    accessorKey: 'plate',
    header: 'Placa',
    cell: ({ row }) => <span className="font-mono tabular">{row.original.plate}</span>,
  },
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
  {
    // VEREDICTO DE OPERABILIDAD (Lote 4) — la pregunta que el operador realmente hace: "¿este vehículo PUEDE
    // recibir viajes?". Lo decide el SERVIDOR (`operable`, el MISMO veredicto que gatea el match: docs SOAT/ITV
    // operables Y ficha linkeada Y docStatus !== EXPIRED) — la UI solo lo REFLEJA. El "por qué" también viene del
    // servidor (`operabilityReason`, computado en la MISMA función que el veredicto) y la UI solo lo ROTULA →
    // cero divergencia, cero magic string (la UI NO re-deriva la regla desde docStatus/segment).
    // Reemplaza el flag `active` stored (DEPRECADO: se seteaba al alta y nada lo mantenía → el panel mentía).
    id: 'operability',
    header: 'Operabilidad',
    cell: ({ row }) => {
      if (row.original.operable) return <Badge tone="success">Operable</Badge>;
      // El MOTIVO viene tipado del servidor (mismo cómputo que el veredicto) → cero divergencia, cero magic string.
      // Rótulo compartido con el DETALLE (fleet-labels) → la lista y /fleet/[id] dicen lo mismo.
      const motivo = operabilityReasonLabel(row.original.operabilityReason) || null;
      return (
        <div className="flex flex-col gap-0.5">
          <Badge tone="danger">No operable</Badge>
          {motivo && <span className="text-xs text-ink-muted">{motivo}</span>}
        </div>
      );
    },
  },
  {
    // F1 · LA FICHA DEL MATCH. El dispatch decide la eligibilidad de oferta (Confort/XL/Premium) con
    // segmento + asientos + el AÑO del vehículo — exactamente lo que driver-pool exige para NO caer en
    // fail-open (`seats || segment || vehicleYear`). La energía NO entra al match ni al pricing del vehículo:
    // el precio de energía sale de la CLASE de la oferta (ADR-017 dec.2 · referenceEnergySource/Efficiency),
    // no del `energySource` real (ese delta es margen privado del conductor). Si falta CUALQUIERA de esos 3
    // el dispatch deja pasar igual (fail-open) → marcamos "Ficha incompleta" con el detalle de qué falta, para
    // que el admin VEA el eslabón que no cierra. `energySource` se MUESTRA como info, pero NO gatilla la alerta.
    id: 'spec',
    header: 'Ficha técnica',
    cell: ({ row }) => {
      const { segment, energySource, seats, year, mtcCategory } = row.original;
      const faltan = [
        !segment ? 'segmento' : null,
        !seats ? 'asientos' : null,
        !year ? 'año' : null,
      ].filter((x): x is string => x !== null);
      if (faltan.length > 0) {
        return (
          <span
            className="inline-flex items-center gap-1 text-xs text-warn"
            title={`El dispatch hace fail-open: falta ${faltan.join(', ')}`}
          >
            <AlertTriangle className="size-3.5" aria-hidden />
            Ficha incompleta
          </span>
        );
      }
      const top = [
        segment ? segmentLabel(segment) : null,
        energySource ? energyLabel(energySource) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const bottom = [mtcCategory, seats ? `${seats} plazas` : null].filter(Boolean).join(' · ');
      return (
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="text-ink">{top || '—'}</span>
          <span className="text-ink-muted">{bottom || '—'}</span>
        </div>
      );
    },
  },
  {
    accessorKey: 'color',
    header: 'Color',
    cell: ({ row }) => <span className="text-ink-muted">{row.original.color ?? '—'}</span>,
  },
  {
    // `status` ES `v.docStatus` (admin-bff fleet.service.ts:324): la VIGENCIA de los papeles del vehículo
    // (SOAT/ITV) — VALID="Vigente" · EXPIRING="Por vencer" · EXPIRED="Vencido". NO es el veredicto de
    // operabilidad (esa es la columna de al lado). Es un INSUMO del veredicto + el aviso temprano: un vehículo
    // `Operable` con docs "Por vencer" hay que renovarlo antes de que flipee. Header "Estado" (genérico) lo hacía
    // ver como duplicado de Operabilidad → "Documentos" deja claro que es la vigencia de papeles.
    accessorKey: 'status',
    header: 'Documentos',
    cell: ({ row }) => <StatusPill status={row.original.status} />,
  },
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
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.vehicleId.slice(0, 8)}</span>
    ),
  },
  // OJO: fleet-service solo registra inspecciones YA realizadas (no agenda) → `status` siempre COMPLETED y
  // `scheduledAt` siempre null (toInspectionView en admin-bff). Las columnas "Estado"/"Programada" eran
  // sintéticas (muertas) y sugerían un sub-estado que el dominio no tiene → se omiten. La fila ES una
  // inspección hecha; lo que importa es CUÁNDO (Realizada), QUIÉN (Inspector) y el RESULTADO.
  {
    accessorKey: 'inspectedAt',
    header: 'Realizada',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.inspectedAt)}</span>,
  },
  {
    accessorKey: 'inspector',
    header: 'Inspector',
    cell: ({ row }) =>
      row.original.inspector ? (
        <span className="font-mono text-xs">{row.original.inspector.slice(0, 8)}</span>
      ) : (
        <span className="text-ink-subtle">—</span>
      ),
  },
  {
    accessorKey: 'result',
    header: 'Resultado',
    cell: ({ row }) =>
      row.original.result ? (
        <StatusPill status={row.original.result} />
      ) : (
        <span className="text-ink-subtle">—</span>
      ),
  },
];

const expiringColumns: ColumnDef<ExpiringDocumentView, unknown>[] = [
  {
    accessorKey: 'type',
    header: 'Tipo',
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

const VEHICLE_TYPE_LABEL: Record<string, string> = { CAR: 'Auto', MOTO: 'Moto' };

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
      <span className="text-ink-muted tabular">
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
      <span className="text-ink-muted font-mono">
        {row.original.requestedBy?.slice(0, 8) ?? '—'}
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
    cell: ({ row }) => <ModelReviewActions model={row.original} />,
  },
];

export default function FleetPage() {
  const router = useRouter();
  const user = useSession();
  const canManage = can(user, 'fleet:manage');
  // El estado de "por revisar" en el dominio de flota es PENDING_REVIEW (no 'PENDING', que es de
  // otros dominios). Con 'PENDING' el filtro no matcheaba ningún enum y el tab quedaba vacío/erroreaba.
  const documents = useFleetDocuments('PENDING_REVIEW');
  const vehicles = useVehicles();
  const inspections = useInspections();
  const expiring = useExpiringDocuments();
  // Cola de modelos por conductores (B5-2.c). El operador alterna entre los PENDING_REVIEW (a curar) y los
  // APPROVED (para REABRIR y corregir una ficha mal cargada · F2). El status es server-side (filtro de la cola).
  const [modelStatus, setModelStatus] = useState<'PENDING_REVIEW' | 'APPROVED'>('PENDING_REVIEW');
  const models = useModelReview(modelStatus);
  // Conteo REAL de vehículos por vigencia documental (docStatus · sin PII). El eje es docStatus, NO el flag
  // `active` deprecado (que nada mantiene → mentía). total = valid + expiringSoon + expired.
  const summary = useVehiclesSummary();
  const counts = summary.data;
  const totalVehicles = counts ? counts.valid + counts.expiringSoon + counts.expired : 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Flota"
        description="Documentos, vehículos, inspecciones y vencimientos próximos."
        breadcrumbs={[{ label: 'Flota' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <div className="pt-4">
          <StatCardGrid>
            <StatCard
              icon={Truck}
              label="Total en flota"
              value={String(totalVehicles)}
              hint="Vehículos registrados"
              loading={summary.isLoading}
            />
            <StatCard
              icon={BadgeCheck}
              label="Papeles vigentes"
              value={String(counts?.valid ?? 0)}
              hint="SOAT / ITV al día"
              hintTone="success"
              loading={summary.isLoading}
            />
            <StatCard
              icon={CalendarClock}
              label="Por vencer"
              value={String(counts?.expiringSoon ?? 0)}
              hint="Renovar pronto"
              hintTone="warn"
              loading={summary.isLoading}
            />
            <StatCard
              icon={FileWarning}
              label="Vencidos"
              value={String(counts?.expired ?? 0)}
              hint="No operables"
              hintTone="danger"
              loading={summary.isLoading}
            />
          </StatCardGrid>
        </div>
        <Tabs defaultValue="documents" className="pt-5">
          <TabsList>
            <TabsTrigger value="documents">Documentos</TabsTrigger>
            <TabsTrigger value="vehicles">Vehículos</TabsTrigger>
            <TabsTrigger value="models">Modelos</TabsTrigger>
            <TabsTrigger value="inspections">Inspecciones</TabsTrigger>
            <TabsTrigger value="expiring">Vencimientos</TabsTrigger>
          </TabsList>

          <TabsContent value="documents">
            {canManage ? (
              <div className="flex justify-end pb-3">
                <CreateDocumentDialog />
              </div>
            ) : null}
            {documents.isError ? (
              <ErrorState onRetry={() => void documents.refetch()} />
            ) : (
              <>
                <DataTable
                  caption="Documentos por revisar"
                  columns={documentColumns}
                  data={documents.data?.pages.flatMap((p) => p.items) ?? []}
                  loading={documents.isLoading}
                  emptyTitle="Sin documentos pendientes"
                  emptyDescription="No hay documentos pendientes de revisión."
                />
                <LoadMore
                  hasNextPage={!!documents.hasNextPage}
                  isFetching={documents.isFetchingNextPage}
                  onLoadMore={() => void documents.fetchNextPage()}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="vehicles">
            {canManage ? (
              <div className="flex justify-end pb-3">
                <CreateVehicleDialog />
              </div>
            ) : null}
            {vehicles.isError ? (
              <ErrorState onRetry={() => void vehicles.refetch()} />
            ) : (
              <>
                <DataTable
                  caption="Vehículos de la flota"
                  columns={vehicleColumns}
                  data={vehicles.data?.pages.flatMap((p) => p.items) ?? []}
                  loading={vehicles.isLoading}
                  emptyTitle="Sin vehículos"
                  emptyDescription="No hay vehículos registrados en la flota todavía."
                  onRowClick={(v) => router.push(`/fleet/${v.id}`)}
                />
                <LoadMore
                  hasNextPage={!!vehicles.hasNextPage}
                  isFetching={vehicles.isFetchingNextPage}
                  onLoadMore={() => void vehicles.fetchNextPage()}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="models">
            <div className="flex gap-1 pb-3">
              <Button
                size="sm"
                variant={modelStatus === 'PENDING_REVIEW' ? 'primary' : 'ghost'}
                onClick={() => setModelStatus('PENDING_REVIEW')}
              >
                Por revisar
              </Button>
              <Button
                size="sm"
                variant={modelStatus === 'APPROVED' ? 'primary' : 'ghost'}
                onClick={() => setModelStatus('APPROVED')}
              >
                Aprobados
              </Button>
            </div>
            {models.isError ? (
              <ErrorState onRetry={() => void models.refetch()} />
            ) : (
              <>
                <DataTable
                  caption={
                    modelStatus === 'PENDING_REVIEW'
                      ? 'Modelos solicitados por revisar'
                      : 'Modelos aprobados (reabrí para corregir la ficha)'
                  }
                  columns={modelColumns}
                  data={models.data?.pages.flatMap((p) => p.items) ?? []}
                  loading={models.isLoading}
                  emptyTitle={
                    modelStatus === 'PENDING_REVIEW' ? 'Sin modelos pendientes' : 'Sin modelos aprobados'
                  }
                  emptyDescription={
                    modelStatus === 'PENDING_REVIEW'
                      ? 'Cuando un conductor solicite un modelo que no está en el catálogo, aparecerá acá.'
                      : 'Los modelos aprobados aparecen acá; podés reabrirlos para corregir su ficha técnica.'
                  }
                />
                <LoadMore
                  hasNextPage={!!models.hasNextPage}
                  isFetching={models.isFetchingNextPage}
                  onLoadMore={() => void models.fetchNextPage()}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="inspections">
            {canManage ? (
              <div className="flex justify-end pb-3">
                <CreateInspectionDialog />
              </div>
            ) : null}
            {inspections.isError ? (
              <ErrorState onRetry={() => void inspections.refetch()} />
            ) : (
              <>
                <DataTable
                  caption="Inspecciones"
                  columns={inspectionColumns}
                  data={inspections.data?.pages.flatMap((p) => p.items) ?? []}
                  loading={inspections.isLoading}
                  emptyTitle="Sin inspecciones"
                  emptyDescription="No hay inspecciones registradas."
                />
                <LoadMore
                  hasNextPage={!!inspections.hasNextPage}
                  isFetching={inspections.isFetchingNextPage}
                  onLoadMore={() => void inspections.fetchNextPage()}
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
