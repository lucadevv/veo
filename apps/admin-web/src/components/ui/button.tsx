'use client';

import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  // Base: target ≥44px (vía altura), foco visible, press scale 0.97 (emil-design-eng).
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control font-semibold ' +
    'transition-[transform,background-color,color,border-color] duration-150 ease-out ' +
    'cursor-pointer select-none active:scale-[0.97] ' +
    'disabled:pointer-events-none disabled:opacity-50 ' +
    'focus-visible:outline-none',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-brand-on hover:bg-brand-hover',
        secondary: 'bg-surface-2 text-ink border border-border hover:border-border-strong',
        ghost: 'bg-transparent text-ink hover:bg-surface-2',
        danger: 'bg-danger text-danger-on hover:bg-danger-hover',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading = false, disabled, children, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      // `disabled || loading` (no `??`): un botón en `loading` NUNCA debe quedar clickeable, AUNQUE el
      // consumidor pase un `disabled` definido. Con `??`, un `disabled={false}` cortocircuitaba el auto-disable
      // por loading → ventana de doble-submit (mordió en refund-dialog y en el botón Verificar del step-up).
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});
