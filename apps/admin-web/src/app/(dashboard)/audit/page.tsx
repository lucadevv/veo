'use client';

import { Suspense, useState } from 'react';
import { ShieldCheck, ShieldX } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { useAudit, useVerifyAuditChain } from '@/lib/api/queries';
import type { AuditEntryView } from '@/lib/api/schemas';
import { dateTime, number } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { LoadMore } from '@/components/ui/load-more';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/ui/states';

const columns: ColumnDef<AuditEntryView, unknown>[] = [
  {
    accessorKey: 'seq',
    header: 'Seq',
    cell: ({ row }) => <span className="font-mono text-xs tabular">{row.original.seq}</span>,
  },
  {
    accessorKey: 'at',
    header: 'Fecha',
    cell: ({ row }) => <span className="text-ink-muted">{dateTime(row.original.at)}</span>,
  },
  {
    accessorKey: 'action',
    header: 'Acción',
    cell: ({ row }) => <span className="text-ink">{row.original.action}</span>,
  },
  {
    accessorKey: 'resourceType',
    header: 'Recurso',
    cell: ({ row }) => (
      <span className="text-ink-muted">
        {row.original.resourceType} · {row.original.resourceId.slice(0, 8)}
      </span>
    ),
  },
  {
    accessorKey: 'actorId',
    header: 'Actor',
    cell: ({ row }) => (
      <span className="font-mono text-xs text-ink-muted">
        {row.original.actorId ? row.original.actorId.slice(0, 8) : 'sistema'}
      </span>
    ),
  },
];

export default function AuditPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-muted">Cargando…</div>}>
      <AuditInner />
    </Suspense>
  );
}

function AuditInner() {
  const user = useSession();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const query = useAudit(applied);
  const verify = useVerifyAuditChain();
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Auditoría"
        description="Registro append-only con cadena de hash verificable."
        breadcrumbs={[{ label: 'Cumplimiento' }, { label: 'Auditoría' }]}
        actions={
          can(user, 'audit:verify') ? (
            <Button
              variant="secondary"
              size="sm"
              loading={verify.isPending}
              onClick={() => verify.mutate()}
            >
              <ShieldCheck className="size-4" aria-hidden />
              Verificar cadena
            </Button>
          ) : null
        }
      />

      {verify.data ? (
        <div
          role="status"
          className={`mx-4 mt-4 flex items-center gap-3 rounded-md border px-4 py-3 lg:mx-6 ${
            verify.data.valid
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-danger/30 bg-danger/10 text-danger'
          }`}
        >
          {verify.data.valid ? (
            <ShieldCheck className="size-5" aria-hidden />
          ) : (
            <ShieldX className="size-5" aria-hidden />
          )}
          <div className="text-sm">
            <p className="font-semibold">
              {verify.data.valid ? 'Cadena íntegra' : 'Cadena comprometida'}
            </p>
            <p className="text-ink-muted">
              {number(verify.data.checkedEntries)} entradas verificadas
              {verify.data.brokenAtSeq ? ` · ruptura en seq ${verify.data.brokenAtSeq}` : ''} ·{' '}
              {dateTime(verify.data.verifiedAt)}
            </p>
          </div>
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(search.trim());
        }}
        className="px-4 py-3 lg:px-6"
      >
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filtrar por acción, recurso o actor…"
          aria-label="Buscar en auditoría"
          className="max-w-md"
        />
      </form>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 lg:px-6">
        {query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Registro de auditoría"
              columns={columns}
              data={rows}
              loading={query.isLoading}
              emptyTitle="Sin registros"
              emptyDescription="No hay eventos de auditoría para los filtros actuales."
            />
            <LoadMore
              hasNextPage={!!query.hasNextPage}
              isFetching={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
            />
          </>
        )}
      </div>
    </div>
  );
}
