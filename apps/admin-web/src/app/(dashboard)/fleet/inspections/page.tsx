'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Lock } from 'lucide-react';
import { useInspections } from '@/lib/api/queries';
import type { InspectionView } from '@/lib/api/schemas';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { date as fmtDate } from '@/lib/formatters';
import { DotPill, type PillTone } from '@/components/ui/dot-pill';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { LoadMore } from '@/components/ui/load-more';

/** Pill de RESULTADO de la inspección (ITV). Mismo mapeo dato→tono que la card de ITV del detalle. */
function resultPill(result: string | null): { tone: PillTone; label: string } {
  if (result === 'PASSED') return { tone: 'success', label: 'Aprobada' };
  if (result === 'FAILED') return { tone: 'danger', label: 'Reprobada' };
  return { tone: 'neutral', label: '—' };
}

const GRID = 'grid grid-cols-[160px_150px_150px_1fr_170px_90px] items-center gap-4';

export default function InspectionsPage() {
  const user = useSession();
  const router = useRouter();

  const inspections = useInspections();

  const rows = useMemo<InspectionView[]>(
    () => inspections.data?.pages.flatMap((p) => p.items) ?? [],
    [inspections.data],
  );

  if (!can(user, 'fleet:review')) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <Lock className="size-6 text-ink-subtle" aria-hidden />
        <p className="text-sm text-ink-muted">
          Necesitás el rol de revisión de flota para ver el historial de inspecciones.
        </p>
      </div>
    );
  }

  return (
    <div className="stagger flex min-h-full flex-col gap-[22px] px-8 py-7">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Inspecciones</h1>

      {/* Tabla */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div
          className={`${GRID} border-b border-border bg-surface-2 px-5 py-3 text-[11px] font-bold uppercase tracking-[0.5px] text-ink-subtle`}
        >
          <span>Vehículo</span>
          <span>Fecha</span>
          <span>Resultado</span>
          <span>Centro (CITV)</span>
          <span>Inspector</span>
          <span />
        </div>

        {inspections.isError ? (
          <ErrorState className="py-10" onRetry={() => void inspections.refetch()} />
        ) : inspections.isLoading ? (
          <div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-[52px] animate-pulse border-b border-border bg-surface-2/40"
              />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            className="py-12"
            title="Sin inspecciones registradas"
            description="No hay inspecciones técnicas (ITV) registradas en la flota."
          />
        ) : (
          rows.map((it) => {
            const rp = resultPill(it.result);
            return (
              <div
                key={it.id}
                className={`${GRID} border-b border-border px-5 py-3 last:border-b-0`}
              >
                <span className="truncate font-mono text-sm font-semibold text-ink">
                  {it.plate ?? `veh_${it.vehicleId.slice(0, 8)}`}
                </span>
                <span className="truncate text-[13px] text-ink-muted">
                  {fmtDate(it.inspectedAt)}
                </span>
                <span>
                  <DotPill tone={rp.tone}>{rp.label}</DotPill>
                </span>
                <span className="truncate text-[13px] text-ink-muted">{it.center ?? '—'}</span>
                <span className="truncate text-[13px] text-ink-muted">{it.inspector ?? '—'}</span>
                <button
                  type="button"
                  onClick={() => router.push(`/fleet/${it.vehicleId}`)}
                  className="inline-flex w-fit items-center gap-1.5 justify-self-end rounded-full border border-accent bg-accent/15 px-3.5 py-2 text-[13px] font-semibold text-accent transition-colors hover:bg-accent/20"
                >
                  Ver
                  <ArrowRight className="size-[13px]" aria-hidden />
                </button>
              </div>
            );
          })
        )}

        <div className="flex items-center justify-between border-t border-border bg-surface-2 px-5 py-3">
          <span className="text-[13px] text-ink-subtle">
            {`Mostrando ${rows.length} inspección${rows.length === 1 ? '' : 'es'}`}
          </span>
          <LoadMore
            hasNextPage={!!inspections.hasNextPage}
            isFetching={inspections.isFetchingNextPage}
            onLoadMore={() => void inspections.fetchNextPage()}
          />
        </div>
      </div>
    </div>
  );
}
