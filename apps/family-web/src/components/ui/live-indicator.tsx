import { cn } from '@/lib/cn';

export interface LiveIndicatorProps {
  /** true = conectado en vivo; false = sin conexión (reconectando). */
  connected: boolean;
  className?: string;
}

/**
 * Indicador "EN VIVO" sutil. El punto late solo cuando hay conexión y se respeta
 * prefers-reduced-motion (globals.css anula la animación).
 */
export function LiveIndicator({ connected, className }: LiveIndicatorProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium tabular',
        connected
          ? 'border-success/30 bg-success/10 text-success-text'
          : 'border-border bg-surface-2 text-ink-muted',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <span className="relative inline-flex size-2">
        {connected ? (
          <span
            className="absolute inline-flex size-full animate-ping rounded-full bg-success/60"
            aria-hidden
          />
        ) : null}
        <span
          className={cn(
            'relative inline-flex size-2 rounded-full',
            connected ? 'bg-success' : 'bg-ink-subtle',
          )}
          aria-hidden
        />
      </span>
      {connected ? 'En vivo' : 'Reconectando'}
    </span>
  );
}
