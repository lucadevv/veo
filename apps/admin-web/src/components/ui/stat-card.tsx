import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Stat card del embudo (icono + label · valor grande · hint coloreado). Reutilizable en Conductores/Vehículos/
 * Revisiones. Jerarquía por tipografía/espaciado; el color del hint solo señala urgencia (warn/danger), no
 * decora. El valor es SIEMPRE dato real del backend (degradación honesta: sin conteo real → no se renderiza).
 */
type HintTone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger';

const HINT_TONE: Record<HintTone, string> = {
  neutral: 'text-ink-subtle',
  brand: 'text-brand',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
};

export interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  hintTone?: HintTone;
  /**
   * Tono del icono del KPI (fiel al frame: wallet brand, check success, pause warn, x danger). NO-BREAKING:
   * default 'neutral' → gris actual (text-ink-subtle), así las cards sin tono no cambian. Reusa la escala HintTone.
   */
  iconTone?: HintTone;
  loading?: boolean;
}

export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  hintTone = 'neutral',
  iconTone = 'neutral',
  loading,
}: StatCardProps) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Icon className={cn('size-4 shrink-0', HINT_TONE[iconTone])} aria-hidden />
        <p className="text-xs font-medium text-ink-muted">{label}</p>
      </div>
      {loading ? (
        <div className="mt-2 h-9 w-16 animate-pulse rounded bg-surface-2" />
      ) : (
        <p className="mt-2 font-display text-3xl font-bold tabular text-ink">{value}</p>
      )}
      {hint && !loading ? (
        <p className={cn('mt-1 text-xs font-medium', HINT_TONE[hintTone])}>{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Grilla responsiva de stat cards (2 col mobile, 4 col desktop). `className` opcional para ajustar las
 * columnas cuando la fila tiene otra cantidad (ej. `lg:grid-cols-5`); twMerge resuelve el conflicto de cols.
 */
export function StatCardGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('grid grid-cols-2 gap-4 lg:grid-cols-4', className)}>{children}</div>;
}
