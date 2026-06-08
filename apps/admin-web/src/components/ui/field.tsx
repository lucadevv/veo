'use client';

import { cloneElement, isValidElement, useId } from 'react';
import { cn } from '@/lib/cn';

export interface FieldProps {
  label: string;
  /** Texto de ayuda persistente (no placeholder). */
  hint?: string;
  /** Mensaje de error; se muestra debajo con role="alert". */
  error?: string;
  required?: boolean;
  className?: string;
  /** Único input/control hijo; se le inyectan id y aria-*. */
  children: React.ReactElement<{
    id?: string;
    'aria-invalid'?: boolean;
    'aria-describedby'?: string;
    required?: boolean;
  }>;
}

/** Campo de formulario accesible: label visible, hint persistente, error con role="alert". */
export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        required,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy || undefined,
      })
    : children;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
