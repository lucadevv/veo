'use client';

import Link from 'next/link';
import { Siren } from 'lucide-react';
import { usePanics } from '@/lib/api/queries';
import { FILTER_ALL } from '@/lib/filters';
import { relativeFromNow } from '@/lib/formatters';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/cn';

type Tone = 'abierto' | 'atendido' | 'cerrado';

/** Mapea el status del backend al badge del diseño. `acknowledgedAt` distingue atendido de abierto. */
function tone(status: string, acknowledgedAt: string | null): { tone: Tone; label: string } {
  const s = status.toUpperCase();
  if (s.includes('RESOLV') || s.includes('CLOSED') || s.includes('FALSE')) {
    return { tone: 'cerrado', label: 'Cerrado' };
  }
  if (acknowledgedAt || s.includes('ACK') || s.includes('ATTEND')) {
    return { tone: 'atendido', label: 'Atendido' };
  }
  return { tone: 'abierto', label: 'Abierto' };
}

const BADGE: Record<Tone, string> = {
  abierto: 'bg-danger/[0.08] text-danger',
  atendido: 'bg-success/[0.12] text-success',
  cerrado: 'bg-surface-2 text-ink-subtle',
};
const DOT: Record<Tone, string> = {
  abierto: 'bg-danger',
  atendido: 'bg-success',
  cerrado: 'bg-ink-subtle',
};

/**
 * Lista "Pánicos recientes" del EnVivo·Dashboard — dato REAL de `usePanics` (GET /security/panics). El diseño
 * muestra nombres/placas; el contrato solo trae id/tripId/passengerId/status/triggeredAt → se muestran los
 * campos reales (viaje + pasajero + "hace X"), sin inventar nombres (degradación honesta).
 */
export function PanicsRecent() {
  const panics = usePanics(FILTER_ALL);
  const rows = panics.data?.items.slice(0, 5) ?? [];

  return (
    <div className="flex h-full flex-1 flex-col rounded-xl border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <div className="flex items-center justify-between pb-2">
        <h2 className="font-display text-base font-semibold text-ink">Pánicos recientes</h2>
        <Link href="/security/panics" className="text-[13px] font-medium text-accent hover:underline">
          Ver todos
        </Link>
      </div>

      {panics.isLoading ? (
        <div className="space-y-2 pt-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : panics.isError ? (
        <ErrorState onRetry={() => void panics.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="Sin pánicos recientes" description="No hay incidentes registrados ahora." />
      ) : (
        <ul>
          {rows.map((p, i) => {
            const t = tone(p.status, p.acknowledgedAt);
            return (
              <li
                key={p.id}
                className={cn(
                  'flex items-center gap-[13px] py-3',
                  i < rows.length - 1 && 'border-b border-[color:var(--divider)]',
                )}
              >
                <span
                  className={cn(
                    'grid size-[38px] shrink-0 place-items-center rounded-[10px]',
                    t.tone === 'abierto' ? 'bg-danger/[0.08] text-danger' : 'bg-bg text-ink-subtle',
                  )}
                >
                  <Siren className="size-[18px]" aria-hidden />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link
                    href={`/security/panics/${p.id}`}
                    className="truncate text-sm font-semibold text-ink hover:text-accent"
                  >
                    Viaje {p.tripId.slice(0, 8)}
                  </Link>
                  <span className="truncate text-xs text-ink-muted">
                    {relativeFromNow(p.triggeredAt)}
                  </span>
                </div>
                <span className="hidden shrink-0 font-mono text-xs text-ink-subtle sm:block">
                  pax {p.passengerId.slice(0, 8)}
                </span>
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                    BADGE[t.tone],
                  )}
                >
                  <span className={cn('size-[7px] rounded-full', DOT[t.tone])} aria-hidden />
                  {t.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
