import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/cn';

type TagTone = 'brand' | 'success' | 'warn' | 'neutral';
const TAG_TONE: Record<TagTone, string> = {
  brand: 'bg-brand/12 text-brand',
  success: 'bg-success/12 text-success',
  warn: 'bg-warn/12 text-warn',
  neutral: 'bg-surface-2 text-ink-muted',
};

/**
 * Card de configuración con el estilo del diseño (veo.pen): contenedor bordeado + header (título + tag) +
 * filas verticales + footer con el aviso de step-up y la acción de guardar. Un card por SECCIÓN — cada una
 * guarda por separado (SaveAction, siempre detrás de step-up MFA). `footer` recibe el <SaveAction/> del panel.
 */
export function ConfigCard({
  title,
  tag,
  tagTone = 'brand',
  description,
  children,
  footer,
}: {
  title: string;
  tag?: string;
  tagTone?: TagTone;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {tag ? (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                TAG_TONE[tagTone],
              )}
            >
              {tag}
            </span>
          ) : null}
        </div>
        {description ? <p className="max-w-2xl text-xs text-ink-subtle">{description}</p> : null}
      </div>

      <div className="mt-4 space-y-3">{children}</div>

      {footer ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
            <ShieldCheck className="size-3.5" aria-hidden />
            Guardar pide tu código TOTP
          </span>
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Fila etiqueta → input con unidad (el patrón A/RateField del diseño): label (+sub mono) a la izquierda, un
 * input boxeado con sufijo de unidad a la derecha. `children` es el <input/> (el panel controla su estado).
 */
export function RateField({
  label,
  sub,
  unit,
  error,
  hint,
  children,
}: {
  label: string;
  sub?: string;
  unit?: string;
  error?: string;
  /** Hint opcional bajo el campo (ej. el LIVE-DIFF before→after). Se oculta cuando hay `error` (el error manda). */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm text-ink-muted">{label}</span>
          {sub ? <span className="font-mono text-[11px] text-ink-subtle">{sub}</span> : null}
        </div>
        <div
          className={cn(
            'flex w-44 shrink-0 items-center gap-2 rounded-md border bg-surface-2 px-3 py-1.5 focus-within:border-brand',
            error ? 'border-danger' : 'border-border-strong',
          )}
        >
          {children}
          {unit ? <span className="shrink-0 text-xs text-ink-subtle">{unit}</span> : null}
        </div>
      </div>
      {error ? <p className="mt-1 text-right text-xs text-danger">{error}</p> : (hint ?? null)}
    </div>
  );
}

/** Input desnudo para usar dentro de RateField (sin borde propio; el borde lo pone la fila). Mono + tabular. */
export function RateInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'tabular w-full min-w-0 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-ink-subtle',
        props.className,
      )}
    />
  );
}
