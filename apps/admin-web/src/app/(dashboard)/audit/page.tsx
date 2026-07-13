'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ShieldCheck, ShieldX, Search, Calendar } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { useAudit, useVerifyAuditChain } from '@/lib/api/queries';
import type { AuditEntryView } from '@/lib/api/schemas';
import { FILTER_ALL } from '@/lib/filters';
import { dateTime, number } from '@/lib/formatters';
import { ROLE_LABELS } from '@/lib/roles';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useRequestAccess } from '@/lib/use-request-access';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { LoadMore } from '@/components/ui/load-more';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState, PermissionState } from '@/components/ui/states';
import { ExportAuditButton } from '@/components/audit/export-audit-button';

// Opciones del dropdown "Categoría" (fiel al frame jf66Y). El value = prefijo de dominio de la `action` real del
// WORM (payment.*, driver.*, media.*…) → el bff/audit-service lo traducen a `action startsWith "${value}."`.
// 'ALL' (FILTER_ALL) lo dropea cleanQuery → trae todas las categorías.
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: FILTER_ALL, label: 'Todas las categorías' },
  { value: 'trip', label: 'Viajes' },
  { value: 'dispatch', label: 'Despacho' },
  { value: 'payment', label: 'Pagos' },
  { value: 'payout', label: 'Liquidaciones' },
  { value: 'driver', label: 'Conductores' },
  { value: 'fleet', label: 'Flota' },
  { value: 'media', label: 'Video' },
  { value: 'panic', label: 'Pánico' },
  { value: 'booking', label: 'Carpooling' },
  { value: 'pricing', label: 'Tarifas' },
  { value: 'user', label: 'Usuarios' },
  { value: 'operator', label: 'Operadores' },
  { value: 'policy', label: 'Gobierno · políticas' },
  { value: 'permission_override', label: 'Gobierno · permisos' },
  { value: 'notification', label: 'Notificaciones' },
  { value: 'rating', label: 'Calificaciones' },
  { value: 'biometric', label: 'Biometría' },
];

// Lima es UTC-5 sin horario de verano (offset constante). El input `type=date` da 'YYYY-MM-DD' que, sin hora, el
// audit-service interpreta como MEDIANOCHE UTC → `to` se expande a fin-de-día UTC = 18:59 Lima (pierde las últimas
// ~5h del día pedido) y `from` arranca 19:00 Lima del día anterior. El backend RESPETA un timestamp con hora
// explícita tal cual (audit.repository → endOfDayIfDateOnly), así que mandamos los bordes del día LIMA en UTC:
//   from 00:00 Lima → +5h UTC (mismo día) · to 23:59:59.999 Lima → +5h UTC (día siguiente 04:59:59.999Z).
const LIMA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
function limaDayStartUtc(date: string): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + LIMA_UTC_OFFSET_MS).toISOString();
}
function limaDayEndUtc(date: string): string {
  const dayEndUtc = new Date(`${date}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000 - 1;
  return new Date(dayEndUtc + LIMA_UTC_OFFSET_MS).toISOString();
}

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
    cell: ({ row }) => <span className="font-mono text-[13px] text-ink">{row.original.action}</span>,
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
    // Actor enriquecido (frame jf66Y · T/RowAudit): avatar + nombre + rol resueltos on-read por el bff (roster de
    // operadores). Si el actor no es staff (evento de dominio) o no resolvió → cae al actorId corto, honesto.
    cell: ({ row }) => {
      const { actorName, actorRole, actorId } = row.original;
      if (!actorId) {
        return <span className="font-mono text-xs text-ink-subtle">sistema</span>;
      }
      if (!actorName) {
        return <span className="font-mono text-xs text-ink-muted">{actorId.slice(0, 8)}</span>;
      }
      return (
        <div className="flex items-center gap-2.5">
          <Avatar name={actorName} size="sm" />
          <div className="flex flex-col leading-tight">
            <span className="font-medium text-ink">{actorName}</span>
            {actorRole ? (
              <span className="text-xs text-ink-subtle">
                {ROLE_LABELS[actorRole] ?? actorRole}
              </span>
            ) : null}
          </div>
        </div>
      );
    },
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
  const requestAccess = useRequestAccess();
  // Prefiltro por deep-link (?q=): "Ver en auditoría" desde el detalle de viaje llega con el tripId ya aplicado.
  const initialQuery = useSearchParams().get('q') ?? '';
  const [search, setSearch] = useState(initialQuery);
  const [appliedQ, setAppliedQ] = useState(initialQuery);
  const [category, setCategory] = useState<string>(FILTER_ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // `from`/`to` (state) quedan crudos 'YYYY-MM-DD' para los <input type=date>; a la API van como bordes del día LIMA
  // en UTC para no perder las últimas horas del día ni arrastrar el día previo (ver limaDay* arriba).
  const filters = {
    q: appliedQ,
    category,
    from: from ? limaDayStartUtc(from) : '',
    to: to ? limaDayEndUtc(to) : '',
  };
  const query = useAudit(filters);
  const verify = useVerifyAuditChain();
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  // GATE de presentación (defensa en profundidad · el admin-bff re-autoriza server-side): sin audit:view, el log
  // NO se renderiza. Separación de funciones (Ley 29733): solo Cumplimiento/Superadmin auditan.
  if (!can(user, 'audit:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Auditoría"
          breadcrumbs={[{ label: 'Cumplimiento' }, { label: 'Auditoría' }]}
        />
        <PermissionState
          className="flex-1"
          section="Auditoría"
          permission="audit:view"
          onRequest={() => requestAccess('audit:view')}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Auditoría"
        description="Registro append-only con cadena de hash verificable."
        breadcrumbs={[{ label: 'Cumplimiento' }, { label: 'Auditoría' }]}
        actions={
          <div className="flex items-center gap-2">
            <ExportAuditButton filters={filters} />
            {can(user, 'audit:verify') ? (
              <Button
                variant="secondary"
                size="sm"
                loading={verify.isPending}
                onClick={() => verify.mutate()}
              >
                <ShieldCheck className="size-4" aria-hidden />
                Verificar cadena
              </Button>
            ) : null}
          </div>
        }
      />

      {verify.isError ? (
        <div
          role="alert"
          className="mx-4 mt-4 flex items-center gap-3 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-danger lg:mx-6"
        >
          <ShieldX className="size-5" aria-hidden />
          <div className="flex-1 text-sm">
            <p className="font-semibold">No se pudo verificar la cadena</p>
            <p className="text-ink-muted">
              {verify.error instanceof Error ? verify.error.message : 'Intentá de nuevo en un momento.'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => verify.mutate()}>
            Reintentar
          </Button>
        </div>
      ) : verify.data ? (
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

      {/* Toolbar fiel al frame jf66Y (T/TableToolbar): buscador (crece) · Categoría · rango de fecha. */}
      <div className="flex flex-wrap items-end gap-3 px-4 py-3 lg:px-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedQ(search.trim());
          }}
          className="relative min-w-56 flex-1"
        >
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            // El `q` matchea action/resource/actorId Y el NOMBRE del operador: el bff resuelve nombre→actorIds
            // contra el roster y los ORea en la query de audit-service (búsqueda por persona, no solo por hash).
            placeholder="Buscar por actor, acción o recurso…"
            aria-label="Buscar en auditoría"
            className="pl-9"
          />
        </form>

        <label className="flex flex-col gap-1">
          <span className="sr-only">Categoría</span>
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filtrar por categoría"
            wrapperClassName="w-52"
          >
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex items-center gap-2">
          <Calendar className="size-4 text-ink-subtle" aria-hidden />
          <span className="sr-only">Desde</span>
          <Input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="Fecha desde"
            className="w-40"
          />
          <span className="text-ink-subtle">–</span>
          <span className="sr-only">Hasta</span>
          <Input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            aria-label="Fecha hasta"
            className="w-40"
          />
        </label>
      </div>

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
