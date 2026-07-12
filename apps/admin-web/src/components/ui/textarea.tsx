'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * Textarea accesible fiel al T/Textarea de veo.pen (caja blanca, borde `border`, radio 12, alto mínimo ~92,
 * texto 15/1.4). Espejo multilínea del Input: mismos estados hover (borde fuerte), focus (borde `brand` azul +
 * ring), disabled y error (aria-invalid → borde danger). `rows`/`resize`/`className` pasan por props.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-h-[92px] w-full rounded-md border border-border bg-surface px-4 py-3 text-[15px] leading-[1.4] text-ink',
        'placeholder:text-ink-subtle transition-colors duration-150 ease-out',
        'hover:border-border-strong focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-danger',
        className,
      )}
      {...props}
    />
  );
});
