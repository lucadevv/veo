'use client';

import { Suspense, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { useTrips, type TripFilters } from '@/lib/api/queries';
import type { TripStatus, TripSummary } from '@/lib/api/schemas';
import { dateTime, money } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/states';
import { TripStatusBadge } from '@/components/trips/status-badge';
import { cn } from '@/lib/cn';

const STATUS_FILTERS: { value: TripStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'Todos' },
  { value: 'IN_PROGRESS', label: 'En curso' },
  { value: 'ARRIVING', label: 'En camino' },
  { value: 'COMPLETED', label: 'Completados' },
  { value: 'CANCELLED', label: 'Cancelados' },
];

const columns: ColumnDef<TripSummary, unknown>[] = [
  {
    accessorKey: 'id',
    header: 'Viaje',
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.id.slice(0, 8)}</span>,
  },
  {
    accessorKey: 'status',
    header: 'Estado',
    cell: ({ row }) => <TripStatusBadge status={row.original.status} />,
  },
  {
    accessorKey: 'passengerId',
    header: 'Pasajero',
    cell: ({ row }) => (
      <span className="font-mono text-xs text-ink-muted">{row.original.passengerId.slice(0, 8)}</span>
    ),
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
  {
    accessorKey: 'fareCents',
    header: 'Tarifa',
    cell: ({ row }) => <span className="tabular">{money(row.original.fareCents)}</span>,
  },
  {
    accessorKey: 'createdAt',
    header: 'Creado',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.createdAt)}</span>,
  },
];

export default function TripsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-muted">Cargando…</div>}>
      <TripsInner />
    </Suspense>
  );
}

function TripsInner() {
  const router = useRouter();
  const params = useSearchParams();

  const filters = useMemo<TripFilters>(
    () => ({
      status: (params.get('status') as TripStatus | 'ALL' | null) ?? 'ALL',
      query: params.get('q') ?? undefined,
    }),
    [params],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value && value !== 'ALL') next.set(key, value);
      else next.delete(key);
      router.replace(`/ops/trips?${next.toString()}`);
    },
    [params, router],
  );

  const query = useTrips(filters);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Viajes"
        description="Historial y viajes en curso con filtros persistentes."
        breadcrumbs={[{ label: 'Operación' }, { label: 'Viajes' }]}
      />

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 lg:px-6">
        <div className="inline-flex rounded-md border border-border bg-surface-2 p-1" role="tablist">
          {STATUS_FILTERS.map((f) => {
            const active = (filters.status ?? 'ALL') === f.value;
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setParam('status', f.value)}
                className={cn(
                  'rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
                  active ? 'bg-surface text-ink shadow-1' : 'text-ink-muted hover:text-ink',
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        {filters.query ? (
          <span className="text-xs text-ink-muted">
            Búsqueda: <span className="font-medium text-ink">{filters.query}</span>
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Listado de viajes"
              columns={columns}
              data={rows}
              loading={query.isLoading}
              emptyTitle="Sin viajes"
              emptyDescription="No hay viajes que coincidan con el filtro."
              onRowClick={(row) => router.push(`/ops/trips/${row.id}`)}
            />
            {query.hasNextPage ? (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="secondary"
                  loading={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  Cargar más
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
