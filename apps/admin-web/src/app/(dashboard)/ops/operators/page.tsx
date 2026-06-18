'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { useOperators } from '@/lib/api/queries';
import type { Operator } from '@/lib/api/schemas';
import { dateTime } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/ui/status-pill';
import { ErrorState } from '@/components/ui/states';
import { OperatorActions } from '@/components/operators/operator-actions';
import { NewOperatorDialog } from '@/components/operators/new-operator-dialog';

/** Etiqueta humana por rol RBAC (los chips de la columna "Roles"). */
const ROLE_LABELS: Record<string, string> = {
  SUPPORT_L1: 'Soporte N1',
  SUPPORT_L2: 'Soporte N2',
  DISPATCHER: 'Despachador',
  COMPLIANCE_SUPERVISOR: 'Cumplimiento',
  FINANCE: 'Finanzas',
  ADMIN: 'Administrador',
  SUPERADMIN: 'Superadmin',
};

const columns: ColumnDef<Operator, unknown>[] = [
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
    accessorKey: 'status',
    header: 'Estado',
    cell: ({ row }) => <StatusPill status={row.original.status} />,
  },
  {
    id: 'roles',
    header: 'Roles',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.roles.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {row.original.roles.map((role) => (
            <Badge key={role} tone="neutral">
              {ROLE_LABELS[role] ?? role}
            </Badge>
          ))}
        </div>
      ) : (
        <span className="text-xs text-ink-subtle">—</span>
      ),
  },
  {
    accessorKey: 'createdAt',
    header: 'Creado',
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
  const user = useSession();
  const query = useOperators();
  const rows = query.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Operadores"
        description="Alta de staff del panel por invitación y gestión de roles (solo ADMIN/SUPERADMIN)."
        breadcrumbs={[{ label: 'Operación' }, { label: 'Operadores' }]}
        actions={can(user, 'operators:create') ? <NewOperatorDialog /> : undefined}
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        <div className="pt-4">
          {query.isError ? (
            <ErrorState onRetry={() => void query.refetch()} />
          ) : (
            <DataTable
              caption="Operadores del panel"
              columns={columns}
              data={rows}
              loading={query.isLoading}
              emptyTitle="Sin operadores"
              emptyDescription="Invita al primer operador con el botón “Nuevo operador”."
            />
          )}
        </div>
      </div>
    </div>
  );
}
