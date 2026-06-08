import { Phone } from 'lucide-react';
import { cn } from '@/lib/cn';
import { publicEnv } from '@/lib/env';

/**
 * Botón de ayuda visible pero no intrusivo. Llama al número de ayuda configurado
 * (por defecto 105, Policía Nacional del Perú). No inventa contactos.
 */
export function HelpButton({ className }: { className?: string }) {
  const phone = publicEnv.helpPhone;
  return (
    <a
      href={`tel:${phone}`}
      className={cn(
        'inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-surface px-4',
        'text-base font-medium text-ink transition-[transform,background-color] duration-150 ease-out',
        'hover:bg-surface-2 active:scale-[0.97]',
        className,
      )}
    >
      <Phone className="size-5 text-accent" aria-hidden />
      Pedir ayuda
    </a>
  );
}
