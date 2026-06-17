import type { StatusTone } from '@veo/ui-kit';
import type { SupportCategory, SupportStatus } from '../entities';

/** Categorías de soporte que el conductor puede elegir, en orden de presentación. */
export const SUPPORT_CATEGORIES = [
  'TRIP',
  'PAYMENT',
  'DRIVER',
  'ACCOUNT',
  'SAFETY',
  'OTHER',
] as const satisfies readonly SupportCategory[];

/** Categoría por defecto del formulario (la primera de la lista). */
export const DEFAULT_SUPPORT_CATEGORY: SupportCategory = 'TRIP';

/** Clave i18n del nombre de una categoría (para el selector y la lista de tickets). */
export function supportCategoryI18nKey(category: SupportCategory): string {
  return `support.category.${category}`;
}

/** Clave i18n de la etiqueta de un estado de ticket. */
export function supportStatusI18nKey(status: SupportStatus): string {
  return `support.status.${status}`;
}

/**
 * Tono semántico del chip de estado:
 *  - OPEN → accent (abierto, esperando)
 *  - IN_PROGRESS → warn (en gestión)
 *  - RESOLVED → success (cerrado)
 */
export function supportStatusTone(status: SupportStatus): StatusTone {
  switch (status) {
    case 'OPEN':
      return 'accent';
    case 'IN_PROGRESS':
      return 'warn';
    case 'RESOLVED':
      return 'success';
    default:
      return 'neutral';
  }
}
