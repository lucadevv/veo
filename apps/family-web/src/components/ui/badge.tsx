import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import type { StatusTone } from '@/lib/format';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
}

// Color nunca es el único indicador: el badge siempre acompaña texto (DESIGN §0.4).
const toneStyles: Record<StatusTone, string> = {
  neutral: 'bg-surface-2 text-ink-muted border-border',
  progress: 'bg-accent/10 text-accent border-accent/30',
  arrived: 'bg-success/15 text-success border-success/30',
  done: 'bg-surface-2 text-ink-muted border-border',
  cancelled: 'bg-danger/10 text-danger border-danger/30',
};

/** Badge de estado del viaje, con tono semántico y borde sutil. */
export function Badge({ tone = 'neutral', className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium',
        toneStyles[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
