'use client';

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Stat card de FINANZAS con el ritmo de la fila EN VIVO (KpiGrid): label muted + número display grande, tabular,
 * tracking apretado. Es propia de Finanzas (no toca el StatCard compartido) porque acá el dinero necesita AIRE y
 * porque una métrica de SEÑAL (con error / pendientes) se tinta suave: la alerta salta por el FONDO, no solo por
 * el número. El valor es SIEMPRE dato real del backend; sin conteo real cae a "—" (degradación honesta).
 */
type Tone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger';

const ICON_TONE: Record<Tone, string> = {
  neutral: 'text-ink-subtle',
  brand: 'text-brand',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
};

export interface MoneyStatProps {
  icon: LucideIcon;
  label: string;
  value: string;
  iconTone?: Tone;
  /**
   * Señal activa: `'danger'` (con error) o `'warn'` (pendientes por resolver) tintan la card entera y colorean el
   * número (mismo recetario que la KpiGrid de En Vivo). `false` = card neutra de dato. NO abre detalle → sin lift.
   */
  alert?: false | 'warn' | 'danger';
  loading?: boolean;
}

export function MoneyStat({
  icon: Icon,
  label,
  value,
  iconTone = 'neutral',
  alert = false,
  loading,
}: MoneyStatProps) {
  const surface =
    alert === 'danger'
      ? 'border-danger/25 bg-danger/[0.04]'
      : alert === 'warn'
        ? 'border-warn/25 bg-warn/[0.04]'
        : 'border-black/[0.05] bg-surface';
  const numberColor =
    alert === 'danger' ? 'text-danger' : alert === 'warn' ? 'text-warn' : 'text-ink';

  return (
    <div className={cn('flex flex-col gap-3 rounded-[18px] border p-[22px] shadow-3', surface)}>
      <div className="flex items-center gap-2">
        <Icon className={cn('size-4 shrink-0', ICON_TONE[iconTone])} aria-hidden />
        <p className="text-[13px] font-medium text-ink-muted">{label}</p>
      </div>
      {loading ? (
        <div className="h-[34px] w-20 animate-pulse rounded-md bg-surface-2" />
      ) : (
        <p
          className={cn(
            'font-display text-[34px] font-bold leading-none tracking-[-1.2px] tabular',
            numberColor,
          )}
        >
          {value}
        </p>
      )}
    </div>
  );
}

/**
 * Grilla de las stat cards de Finanzas: cascada de entrada (`stagger`) como la KpiGrid de En Vivo — la fila de
 * dinero entra escalonada, no toda de golpe. `className` ajusta las columnas cuando la fila tiene otra cantidad.
 */
export function MoneyStatGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('stagger grid grid-cols-2 gap-4 lg:grid-cols-4', className)}>{children}</div>
  );
}
