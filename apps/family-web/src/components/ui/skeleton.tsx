import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** Placeholder de carga. La animación se anula con prefers-reduced-motion (globals.css). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-surface-2', className)}
      {...props}
    />
  );
}
