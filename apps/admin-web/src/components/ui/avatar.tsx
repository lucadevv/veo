import { cn } from '@/lib/cn';

/** Iniciales (hasta 2) del nombre; "—" si no hay nombre. */
function initials(name: string | null | undefined): string {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const value = ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  return value || '—';
}

/** Avatar de iniciales (conductor/operador). Tinte brand tenue sobre anillo de borde, coherente con el sidebar. */
export function Avatar({
  name,
  size = 'md',
}: {
  name: string | null | undefined;
  size?: 'sm' | 'md';
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-brand/12 font-semibold text-brand ring-1 ring-inset ring-border-strong',
        size === 'sm' ? 'size-8 text-xs' : 'size-9 text-sm',
      )}
    >
      {initials(name)}
    </span>
  );
}
