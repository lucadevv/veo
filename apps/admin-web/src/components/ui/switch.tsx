'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  /** Estado on/off (controlled). */
  checked: boolean;
  /** Etiqueta accesible (→ aria-label). */
  label: string;
  /** Callback de conmutación directa. Opcional: cuando el switch envuelve un StepUpDialog (trigger),
   *  se omite y el onClick inyectado por Radix maneja la acción. */
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * Switch accesible (button role="switch") fiel al T/Switch de veo.pen (track 50×30 pill, knob blanco 24 con
 * sombra, padding 3). ON = track `brand` (AZUL, jerarquía trust: primario/estado-on → brand, nunca verde);
 * OFF = track gris neutro. forwardRef para servir de trigger de Radix (StepUpDialog asChild le inyecta onClick).
 * Controlled: `checked` + `onCheckedChange` (o, como trigger, el onClick que inyecta el padre).
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, label, disabled, className, onCheckedChange, onClick, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onCheckedChange?.(!checked);
      }}
      className={cn(
        'inline-flex h-[30px] w-[50px] shrink-0 cursor-pointer items-center rounded-full p-[3px] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
        checked ? 'justify-end bg-brand' : 'justify-start bg-border-strong',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      {...props}
    >
      <span className="size-6 rounded-full bg-surface shadow-1" />
    </button>
  );
});
