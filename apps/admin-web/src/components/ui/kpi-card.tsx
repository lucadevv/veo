import { TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Tarjeta KPI del veo.pen (board admin): label + valor grande (Space Grotesk) + delta pill opcional. El delta es
 * una FRACCIÓN real (0.18 = +18%); `null`/undefined → sin pill (no se inventa un % sin base). `alert` pinta el
 * valor en danger (ej. pánicos > 0). Reusable en todas las pantallas de dashboard.
 */
export function KpiCard({
  label,
  value,
  deltaPct,
  alert,
}: {
  label: string;
  value: string;
  deltaPct?: number | null;
  alert?: boolean;
}) {
  const up = (deltaPct ?? 0) >= 0;
  return (
    <div className="flex flex-col gap-2.5 rounded-[18px] border border-black/[0.05] bg-surface p-[22px] shadow-3">
      <p className="text-[13px] font-medium text-ink-muted">{label}</p>
      <p
        className={cn(
          'font-display text-[38px] font-bold leading-none tracking-[-1px] tabular',
          alert ? 'text-danger' : 'text-ink',
        )}
      >
        {value}
      </p>
      {deltaPct != null ? (
        <span
          className={cn(
            'flex w-fit items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold',
            up ? 'bg-success/[0.12] text-success' : 'bg-danger/[0.08] text-danger',
          )}
        >
          {up ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
          {up ? '+' : ''}
          {(deltaPct * 100).toFixed(deltaPct === 0 ? 0 : 1)}%
        </span>
      ) : null}
    </div>
  );
}
