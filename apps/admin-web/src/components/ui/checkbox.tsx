'use client';

import { forwardRef, useId } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Etiqueta a la derecha de la casilla. */
  label?: string;
}

/**
 * Checkbox accesible fiel al T/Checkbox de veo.pen (18×18, r5, marcado = accent + tilde blanco).
 * El input nativo queda oculto pero operable (peer): recibe foco, teclado y estados de forma real;
 * la casilla visual es un span que reacciona con `peer-checked` / `peer-focus-visible`.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, label, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label htmlFor={inputId} className={cn('inline-flex cursor-pointer items-center gap-2.5', className)}>
      <span className="relative grid size-[18px] place-items-center">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className="peer absolute inset-0 cursor-pointer appearance-none rounded-[5px] border border-border bg-surface transition-colors checked:border-accent checked:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40"
          {...props}
        />
        <Check
          className="pointer-events-none relative size-3 text-on-accent opacity-0 transition-opacity peer-checked:opacity-100"
          strokeWidth={3}
          aria-hidden
        />
      </span>
      {label ? <span className="text-[13px] text-ink-muted">{label}</span> : null}
    </label>
  );
});
