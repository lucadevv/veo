'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronRight, Film, Lock, X } from 'lucide-react';
import { FILTER_ALL } from '@/lib/filters';
import { useMediaRequests } from '@/lib/api/queries';
import type { MediaAccessRequestView } from '@/lib/api/schemas';
import { ROLE_LABELS } from '@/lib/roles';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { RequestAccessDialog } from '@/components/media/request-access-dialog';
import { MediaRequestDetail } from '@/components/media/media-request-detail';

/**
 * Acceso a video grabado (fiel al frame rMKhS) — master-detail: TABLA de solicitudes (área principal, izq) +
 * detalle del seleccionado (sidebar der, MediaRequestDetail). Doble autorización de Cumplimiento (Ley 29733):
 * un operador SOLICITA y otro APRUEBA con step-up MFA. La LÓGICA (MediaActions + RBAC media:*) se preserva; solo
 * cambia la presentación (tabs→página por tabla+detalle en vivo).
 */
export default function MediaPage() {
  const user = useSession();
  const query = useMediaRequests(FILTER_ALL);
  const rows = useMemo<MediaAccessRequestView[]>(() => query.data?.items ?? [], [query.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deep-link desde el detalle de un pánico (`?trip=`): la solicitud de ESE viaje. Antes el param se ignoraba y
  // el operador caía en la tabla completa (auto-select del primero) sin llegar a la grabación del pánico.
  const focusTrip = useSearchParams().get('trip');
  const focusRow = focusTrip ? (rows.find((r) => r.tripId === focusTrip) ?? null) : null;

  // Auto-selección: la solicitud del `?trip` si existe; si no, la primera, conservando la selección al recargar.
  useEffect(() => {
    if (rows.length === 0) {
      setSelectedId(null);
      return;
    }
    const focusMatch = focusTrip ? rows.find((r) => r.tripId === focusTrip) : undefined;
    setSelectedId((cur) => {
      if (focusMatch) return focusMatch.id;
      return cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null);
    });
  }, [rows, focusTrip]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const pending = rows.filter((r) => r.status === 'PENDING').length;
  // El pánico apunta a un viaje SIN solicitud de acceso todavía → guiar a crearla (prefill).
  const focusNoRequest = !!focusTrip && !focusRow && !query.isLoading && !query.isError;

  if (!can(user, 'media:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Acceso a video grabado"
          breadcrumbs={[{ label: 'Seguridad' }, { label: 'Video' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol de Cumplimiento o Administrador para el acceso a video."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Acceso a video grabado"
        description="Doble autorización de Cumplimiento · Ley 29733"
        breadcrumbs={[{ label: 'Seguridad' }, { label: 'Video' }]}
        actions={
          <div className="flex items-center gap-3">
            {pending > 0 ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-warn/10 px-3 py-1.5 text-[13px] font-semibold text-warn">
                {pending} pendiente{pending === 1 ? '' : 's'}
              </span>
            ) : null}
            {can(user, 'media:request') ? <RequestAccessDialog /> : null}
          </div>
        }
      />

      {/* Contexto del deep-link de pánico: la solicitud del viaje, o guiar a crearla si no existe. */}
      {focusTrip && focusRow ? (
        <div className="mx-4 mt-4 flex items-center gap-2.5 rounded-xl border border-brand/25 bg-brand/8 px-4 py-2.5 text-sm text-brand lg:mx-6">
          <Film className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            Mostrando la solicitud del viaje del pánico{' '}
            <span className="font-mono text-xs">{focusTrip.slice(0, 8)}</span>.
          </span>
          <Link
            href="/media"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold hover:bg-brand/10"
          >
            <X className="size-3.5" aria-hidden /> Ver todas
          </Link>
        </div>
      ) : focusNoRequest ? (
        <div className="mx-4 mt-4 flex items-center gap-2.5 rounded-xl border border-warn/30 bg-warn/10 px-4 py-2.5 text-sm text-warn lg:mx-6">
          <Film className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            No hay solicitud de acceso para el viaje{' '}
            <span className="font-mono text-xs">{focusTrip.slice(0, 8)}</span> del pánico.
          </span>
          {can(user, 'media:request') ? <RequestAccessDialog defaultTripId={focusTrip} /> : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-4 p-4 lg:p-6">
        {/* Área principal: tabla de solicitudes (todos los estados) */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-black/[0.05] bg-surface shadow-3">
          {query.isError ? (
            <ErrorState onRetry={() => void query.refetch()} className="m-6" />
          ) : query.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              className="flex-1"
              icon={<Film className="size-6" aria-hidden />}
              title="Sin solicitudes"
              description="No hay solicitudes de acceso a video."
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-[1] bg-surface">
                  <tr className="border-b border-[color:var(--divider)] text-left">
                    <Th>Solicitante</Th>
                    <Th>Motivo</Th>
                    <Th>Objetivo</Th>
                    <Th>Estado</Th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <RequestRow
                      key={r.id}
                      row={r}
                      selected={r.id === selectedId}
                      onSelect={() => setSelectedId(r.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Sidebar: detalle de la solicitud seleccionada */}
        <div className="flex w-[380px] shrink-0 flex-col overflow-hidden rounded-2xl border border-black/[0.05] bg-surface shadow-3">
          {selected ? (
            <MediaRequestDetail request={selected} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={<Film className="size-6" aria-hidden />}
                title="Seleccioná una solicitud"
                description="Elegí una fila para ver el detalle y decidir."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Celda de encabezado de la tabla (uppercase · muted). */
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-subtle">
      {children}
    </th>
  );
}

/** Iniciales (2) para el avatar del solicitante en la fila. */
function initials(text: string): string {
  const p = text.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || (text[0]?.toUpperCase() ?? '•');
}

/** Fila de la tabla: solicitante (avatar+nombre+rol) · motivo · objetivo (viaje) · estado · chevron. */
function RequestRow({
  row,
  selected,
  onSelect,
}: {
  row: MediaAccessRequestView;
  selected: boolean;
  onSelect: () => void;
}) {
  const who = row.requesterName ?? row.requesterEmail;
  const roleLabel = row.requesterRole ? (ROLE_LABELS[row.requesterRole] ?? row.requesterRole) : null;
  return (
    <tr
      onClick={onSelect}
      aria-selected={selected}
      className={cn(
        'cursor-pointer border-b border-[color:var(--divider)] transition-colors last:border-b-0',
        selected ? 'bg-accent/[0.05]' : 'hover:bg-surface-2',
      )}
    >
      {/* Solicitante */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent">
            {initials(who)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-ink">{who}</span>
            <span className="truncate text-xs text-ink-subtle">{roleLabel ?? row.requesterEmail}</span>
          </span>
        </div>
      </td>
      {/* Motivo */}
      <td className="max-w-[240px] px-4 py-3">
        <span className="line-clamp-1 text-sm text-ink">{row.reason}</span>
      </td>
      {/* Objetivo */}
      <td className="px-4 py-3">
        <span className="whitespace-nowrap font-mono text-xs text-ink-muted">
          Viaje #{row.tripId.slice(0, 8)}
        </span>
      </td>
      {/* Estado */}
      <td className="px-4 py-3">
        <StatusPill status={row.status} />
      </td>
      {/* Chevron */}
      <td className="px-3 py-3 text-right">
        <ChevronRight className="inline size-4 text-ink-subtle" aria-hidden />
      </td>
    </tr>
  );
}
