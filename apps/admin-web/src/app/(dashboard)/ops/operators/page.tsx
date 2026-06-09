'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { useOperators } from '@/lib/api/queries';
import type { PendingOperator } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { ErrorState } from '@/components/ui/states';
import { OperatorActions } from '@/components/operators/operator-actions';

const columns: ColumnDef<PendingOperator, unknown>[] = [
  {
    accessorKey: 'email',
    header: 'Operador',
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="text-ink">{row.original.email}</span>
        <span className="font-mono text-xs text-ink-muted">{row.original.id.slice(0, 8)}</span>
      </div>
    ),
  },
  {
    accessorKey: 'createdAt',
    header: 'Solicitado',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.createdAt)}</span>,
  },
  {
    id: 'actions',
    header: 'Acciones',
    enableSorting: false,
    cell: ({ row }) => <OperatorActions operator={row.original} />,
  },
];

export default function OperatorsPage() {
  const query = useOperators();
  const rows = query.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Operadores"
        description="Aprobación de altas de staff del panel y asignación de roles (solo ADMIN)."
        breadcrumbs={[{ label: 'Operación' }, { label: 'Operadores' }]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <div className="pt-4">
          {query.isError ? (
            <ErrorState onRetry={() => void query.refetch()} />
          ) : (
            <DataTable
              caption="Operadores pendientes de aprobación"
              columns={columns}
              data={rows}
              loading={query.isLoading}
              emptyTitle="Sin operadores pendientes"
              emptyDescription="No hay altas de operadores esperando aprobación."
            />
          )}
        </div>
      </div>
    </div>
  );
}
