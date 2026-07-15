import { cn } from '@/lib/cn';

/**
 * Pill de estado del frame (C/StatusPill): dot + label, fondo tenue (`-dim`) + contenido sólido por tono.
 * Reutilizable en las tablas de FLOTA (Documentos/Verificación/Estado). El tono se decide en el call-site
 * (mapeo dato→semántica), acá solo se pinta — un componente canónico, cero copy-paste de pills.
 */
export type PillTone = 'brand' | 'success' | 'warn' | 'danger' | 'neutral' | 'muted';

const TONE: Record<PillTone, { bg: string; fg: string; dot: string }> = {
  brand: { bg: 'bg-accent/15', fg: 'text-accent', dot: 'bg-accent' },
  success: { bg: 'bg-success/15', fg: 'text-success', dot: 'bg-success' },
  warn: { bg: 'bg-warn/15', fg: 'text-warn', dot: 'bg-warn' },
  danger: { bg: 'bg-danger/15', fg: 'text-danger', dot: 'bg-danger' },
  neutral: { bg: 'bg-surface-2', fg: 'text-ink-subtle', dot: 'bg-ink-subtle' },
  muted: { bg: 'bg-surface-2', fg: 'text-ink-muted', dot: 'bg-ink-muted' },
};

export function DotPill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-[13px] font-medium',
        t.bg,
        t.fg,
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', t.dot)} aria-hidden />
      {children}
    </span>
  );
}
