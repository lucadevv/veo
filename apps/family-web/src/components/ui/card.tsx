import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** Tarjeta: borde 1px (sin sombra simultánea, anti ghost-card), radio 16px. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface', className)}
      {...props}
    />
  );
}
