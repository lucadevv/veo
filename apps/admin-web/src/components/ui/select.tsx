'use client';

import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Clases del contenedor relativo (por defecto ocupa todo el ancho; overrideable p.ej. `w-44`). */
  wrapperClassName?: string;
}

/**
 * Select accesible fiel al T/Select de veo.pen (control blanco, borde `border`, radio 12, chevron a la
 * derecha). `<select>` nativo estilado (a11y + teclado nativos) con la flecha del SO oculta (appearance-none)
 * y un chevron propio (lucide, consistente con el resto del admin). Estados: hover (borde fuerte), focus
 * (borde `brand` azul + ring), disabled, error (aria-invalid → borde danger). Reusa el estilo del Input.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, wrapperClassName, children, ...props },
  ref,
) {
  return (
    <div className={cn('relative w-full', wrapperClassName)}>
      <select
        ref={ref}
        className={cn(
          'h-12 w-full cursor-pointer appearance-none rounded-md border border-border bg-surface pl-4 pr-10 text-[15px] text-ink',
          'transition-colors duration-150 ease-out hover:border-border-strong',
          'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-danger',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
        aria-hidden
      />
    </div>
  );
});
