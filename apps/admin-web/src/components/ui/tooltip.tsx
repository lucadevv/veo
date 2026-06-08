'use client';

import { useId, useState } from 'react';
import { cn } from '@/lib/cn';

interface TooltipProps {
  label: string;
  children: React.ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}

/**
 * Tooltip accesible ligero (sin dependencia externa): aparece en hover y foco,
 * se asocia por aria-describedby y respeta @media (hover) vía eventos de foco.
 */
export function Tooltip({ label, children, side = 'top', className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      <span
        role="tooltip"
        id={id}
        className={cn(
          'pointer-events-none absolute left-1/2 z-tooltip -translate-x-1/2 whitespace-nowrap rounded-sm',
          'bg-ink px-2 py-1 text-xs font-medium text-bg shadow-2 transition-opacity duration-150 ease-out',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
          open ? 'opacity-100' : 'opacity-0',
          className,
        )}
      >
        {label}
      </span>
    </span>
  );
}
