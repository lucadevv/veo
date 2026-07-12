'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type ?? 'text'}
      className={cn(
        'h-12 w-full rounded-md border border-border bg-surface px-4 text-[15px] text-ink',
        'placeholder:text-ink-subtle transition-colors duration-150 ease-out',
        'hover:border-border-strong focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
        'aria-[invalid=true]:border-danger',
        className,
      )}
      {...props}
    />
  );
});
