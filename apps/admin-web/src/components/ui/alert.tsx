import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Mensaje INLINE persistente — la contraparte del `Toast` EFÍMERO (que aparece y desaparece).
 *
 * Fiel a los specimens del board Trust UI Kit:
 * - `T/Alert` (DL5II): ícono tonal + título + cuerpo + descarte (X).
 * - `T/Banner` (IY5vt): ícono tonal + título + cuerpo + acción trailing.
 * Son la MISMA estructura (leading ícono · texto · trailing); el trailing es un slot opcional
 * (`onDismiss` → X, `action` → botón). Por eso es UN solo componente con slots, no dos. El ancho lo
 * fija el contenedor (el board muestra 480 vs 560, diferencia contextual, no estructural).
 * `T/Callout` (UiFF9) SÍ es distinto (barra de acento en vez de ícono, superficie neutra, sin
 * trailing) → componente `Callout` aparte, abajo.
 *
 * Tonos: reusa el sistema del admin (`badge.tsx` / `states.tsx`) — tint `bg-{tono}/10`, borde
 * `border-{tono}/25`, ícono `text-{tono}`. `info` = cyan (--info, scoped en tailwind.config).
 * Fidelidad honesta: el board pinta título+cuerpo con verdes/ámbares OSCUROS bespoke (#0A5B31,
 * #7A4A00) que NO existen como token — usar el token crudo (p. ej. text-warn #FFA000 sobre warn/10)
 * no pasaría contraste AA. Por eso el texto va NEUTRO (text-ink / text-ink-muted), igual que Toast y
 * ErrorState; la identidad del tono la dan el ícono + el tint + el borde.
 */

type AlertTone = 'info' | 'success' | 'warn' | 'danger';

const alertVariants = cva('flex gap-3 rounded-control border p-4', {
  variants: {
    tone: {
      info: 'bg-info/10 border-info/25',
      success: 'bg-success/10 border-success/25',
      warn: 'bg-warn/10 border-warn/30',
      danger: 'bg-danger/10 border-danger/25',
    },
  },
  defaultVariants: { tone: 'info' },
});

const toneIcon: Record<AlertTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  danger: AlertCircle,
};

const toneAccent: Record<AlertTone, string> = {
  info: 'text-info',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
};

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof alertVariants> {
  /** Título opcional en negrita (T/Alert y T/Banner lo muestran). */
  title?: React.ReactNode;
  /** Ícono override; por defecto el del tono. */
  icon?: LucideIcon;
  /** Acción trailing (patrón T/Banner): pasá un `<Button size="sm">`. */
  action?: React.ReactNode;
  /** Handler de descarte (patrón T/Alert): renderiza la X. */
  onDismiss?: () => void;
}

export function Alert({
  className,
  tone,
  title,
  icon,
  action,
  onDismiss,
  children,
  ...props
}: AlertProps) {
  const resolvedTone: AlertTone = tone ?? 'info';
  const Icon = icon ?? toneIcon[resolvedTone];
  return (
    <div
      // `info` es informativo (no urgente) → `status`; el resto interrumpe → `alert`.
      role={resolvedTone === 'info' ? 'status' : 'alert'}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', toneAccent[resolvedTone])} aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        {title ? <p className="text-sm font-semibold text-ink">{title}</p> : null}
        {children ? (
          <div className="text-sm leading-relaxed text-ink-muted">{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Cerrar aviso"
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded transition-opacity hover:opacity-70',
            toneAccent[resolvedTone],
          )}
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/**
 * T/Callout (UiFF9): aviso NEUTRO con barra de acento a la izquierda (sin ícono, sin trailing).
 * El board lo muestra con superficie neutra (`surface-2` + borde) y barra `brand` (azul). La barra
 * acepta un `tone` opcional para recolorearla (info/success/warn/danger) sin cambiar la superficie.
 */
const calloutBar: Record<AlertTone | 'neutral', string> = {
  neutral: 'bg-brand',
  info: 'bg-info',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

export interface CalloutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Título opcional en negrita. */
  title?: React.ReactNode;
  /** Color de la barra de acento. Default `neutral` (brand), fiel al board. */
  tone?: AlertTone | 'neutral';
}

export function Callout({ className, title, tone = 'neutral', children, ...props }: CalloutProps) {
  return (
    <div
      role="note"
      className={cn('flex gap-3 rounded-control border border-border bg-surface-2 p-4', className)}
      {...props}
    >
      <span className={cn('w-1 shrink-0 self-stretch rounded-full', calloutBar[tone])} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="text-sm font-semibold text-ink">{title}</p> : null}
        {children ? (
          <div className="text-sm leading-relaxed text-ink-muted">{children}</div>
        ) : null}
      </div>
    </div>
  );
}
