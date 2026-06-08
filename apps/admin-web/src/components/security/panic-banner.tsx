'use client';

import Link from 'next/link';
import { ShieldAlert, X } from 'lucide-react';
import { useOpsStore } from '@/lib/realtime/ops-store';
import { time } from '@/lib/formatters';

/**
 * Banner global de pánico. Destaca con color danger + icono + texto (nunca solo color),
 * cumpliendo accesibilidad. Aparece sobre el contenido cuando hay pánicos activos en vivo.
 */
export function PanicBanner() {
  const panics = useOpsStore((s) => s.panics);
  const dismiss = useOpsStore((s) => s.dismissPanic);

  if (panics.length === 0) return null;
  const latest = panics[0];
  if (!latest) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-center gap-3 border-b border-danger/30 bg-danger/10 px-4 py-2.5 lg:px-6"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-danger text-danger-on animate-pulse-danger">
        <ShieldAlert className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-danger">
          PÁNICO ACTIVO · {panics.length} alerta{panics.length > 1 ? 's' : ''} en curso
        </p>
        <p className="truncate text-xs text-ink-muted tabular">
          Viaje {latest.tripId.slice(0, 8)} · {latest.status} · {time(latest.triggeredAt)}
        </p>
      </div>
      <Link
        href={`/security/panics/${latest.panicId}`}
        className="rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-danger-on transition-transform active:scale-[0.97]"
      >
        Atender
      </Link>
      <button
        type="button"
        onClick={() => dismiss(latest.panicId)}
        aria-label="Descartar del banner"
        className="grid size-7 place-items-center rounded-md text-ink-muted hover:text-ink"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
