'use client';

import { useEffect, useMemo, useState } from 'react';
import { ShieldAlert, Lock } from 'lucide-react';
import { PanicStatus } from '@veo/shared-types';
import { PANIC_TABS, DEFAULT_PANIC_TAB, type PanicTab } from '@/lib/panics';
import { usePanics } from '@/lib/api/queries';
import type { PanicSummary } from '@/lib/api/schemas';
import { relativeFromNow } from '@/lib/formatters';
import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { cn } from '@/lib/cn';
import { PanicDetailPanel } from '@/components/security/panic-detail-panel';

/**
 * Centro de pánico (fiel al frame BQPRE) — master-detail de UNA pantalla: lista de incidentes (izq) +
 * detalle en vivo del seleccionado (der, PanicDetailPanel). Reemplaza el patrón lista→página-de-detalle:
 * un operador de seguridad ve la cola Y responde sin cambiar de pantalla. La LÓGICA de seguridad (ack/
 * resolve/evidencia + RBAC panics:*) vive en PanicDetailPanel y se preserva intacta.
 */
export default function PanicsPage() {
  const user = useSession();
  const [tab, setTab] = useState<PanicTab>(DEFAULT_PANIC_TAB);
  const query = usePanics(tab);
  const rows = useMemo<PanicSummary[]>(() => query.data?.items ?? [], [query.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-selección: el primer incidente de la vista, o se conserva la selección si sigue presente al
  // recargar/cambiar de tab (evita que el panel derecho quede vacío mientras hay incidentes).
  useEffect(() => {
    if (rows.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null)));
  }, [rows]);

  // "Activos" = no resueltos (TRIGGERED + ACKNOWLEDGED). Derivado de las filas cargadas (sin endpoint de
  // resumen): exacto en el tab "Todos"; en los tabs de estado coincide con el total de la vista.
  const activos = rows.filter((r) => r.status !== PanicStatus.RESOLVED).length;

  if (!can(user, 'panics:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Centro de pánico"
          breadcrumbs={[{ label: 'Seguridad' }, { label: 'Pánicos' }]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol correspondiente para ver las alertas de pánico."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Centro de pánico"
        breadcrumbs={[{ label: 'Seguridad' }, { label: 'Pánicos' }]}
        actions={
          activos > 0 ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-danger/10 px-3 py-1.5 text-[13px] font-semibold text-danger">
              <span className="size-2 rounded-full bg-danger" aria-hidden />
              {activos} activo{activos === 1 ? '' : 's'}
            </span>
          ) : null
        }
      />

      <div className="flex min-h-0 flex-1 gap-4 p-4 lg:p-6">
        {/* Panel izquierdo: cola de incidentes */}
        <div className="flex w-[360px] shrink-0 flex-col overflow-hidden rounded-2xl border border-black/[0.05] bg-surface shadow-3">
          <div className="flex items-center justify-between border-b border-[color:var(--divider)] px-4 py-3">
            <p className="text-sm font-semibold text-ink">Incidentes</p>
            <span className="text-xs text-ink-muted">{rows.length}</span>
          </div>
          <div className="flex gap-1 border-b border-[color:var(--divider)] p-2">
            {PANIC_TABS.map((t) => (
              <button
                key={String(t.value)}
                type="button"
                onClick={() => setTab(t.value)}
                className={cn(
                  'flex-1 rounded-[9px] px-2 py-1.5 text-xs font-medium transition-colors',
                  tab === t.value ? 'bg-accent/10 text-accent' : 'text-ink-muted hover:bg-surface-2',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {query.isError ? (
              <ErrorState onRetry={() => void query.refetch()} className="m-2" />
            ) : query.isLoading ? (
              <div className="space-y-2 p-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState title="Sin alertas" description="No hay alertas en esta vista." />
            ) : (
              <ul className="stagger space-y-2">
                {rows.map((r) => (
                  <li key={r.id}>
                    <IncidentCard
                      row={r}
                      selected={r.id === selectedId}
                      onSelect={() => setSelectedId(r.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Panel derecho: detalle del incidente seleccionado */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-black/[0.05] bg-surface shadow-3">
          {selectedId ? (
            <PanicDetailPanel id={selectedId} />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={<ShieldAlert className="size-6" aria-hidden />}
                title="Seleccioná un incidente"
                description="Elegí una alerta de la lista para ver el detalle y responder."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Card de incidente en la cola: id + estado + tiempo relativo + viaje. Activo (TRIGGERED) → resalte rojo. */
function IncidentCard({
  row,
  selected,
  onSelect,
}: {
  row: PanicSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const active = row.status === PanicStatus.TRIGGERED;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'card-interactive w-full rounded-xl border p-3 text-left',
        selected
          ? 'border-accent bg-accent/[0.04]'
          : active
            ? 'border-danger/30 bg-danger/[0.03] hover:bg-danger/[0.06]'
            : 'border-black/[0.05] hover:bg-surface-2',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <ShieldAlert
            className={cn('size-4 shrink-0', active ? 'text-danger' : 'text-ink-subtle')}
            aria-hidden
          />
          <span className="truncate font-mono text-[13px] font-medium text-ink">
            #{row.id.slice(0, 8)}
          </span>
        </span>
        <StatusPill status={row.status} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-ink-muted">
        <span>{relativeFromNow(row.triggeredAt)}</span>
        <span className="font-mono">Viaje {row.tripId.slice(0, 8)}</span>
      </div>
    </button>
  );
}
