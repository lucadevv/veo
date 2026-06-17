import { findOffering, OfferingId } from '@veo/shared-types';
import type { CatalogOverride } from '@/lib/api/schemas';

/**
 * Helpers PUROS del catálogo de ofertas para el admin (ADR 013). Nombre legible por oferta: el catálogo
 * canónico (labelKey i18n) vive en el app del pasajero; acá basta un display map chico para el panel.
 * Degradación honesta: un id desconocido (oferta nueva en el server, admin-web sin actualizar) cae al id
 * crudo en vez de romper.
 *
 * `satisfies Record<OfferingId, string>` da EXHAUSTIVIDAD en compile-time (espejo del catálogo en
 * shared-types): una oferta nueva sin su nombre legible acá NO compila — mata el dominó que dejó a las
 * verticales B5-4 mostrándose con su id crudo en el panel. Las verticales nacen ocultas (defaultEnabled:
 * false), pero el admin las VE en el panel para desbloquearlas (la feature pagable), así que necesitan nombre.
 */
const OFFERING_NAMES = {
  [OfferingId.VEO_MOTO]: 'VEO Moto',
  [OfferingId.VEO_ECONOMICO]: 'VEO Económico',
  [OfferingId.VEO_CONFORT]: 'VEO Confort',
  [OfferingId.VEO_XL]: 'VEO XL',
  [OfferingId.VEO_ECONOMICO_EV]: 'VEO Económico Eléctrico',
  [OfferingId.VEO_AMBULANCE]: 'VEO Ambulancia',
  [OfferingId.VEO_TOW]: 'VEO Grúa',
  [OfferingId.VEO_MECHANIC]: 'VEO Mecánico',
} satisfies Record<OfferingId, string>;

export function offeringLabel(id: string): string {
  // Lookup tolerante (el id llega como string crudo del server): id conocido → nombre; desconocido → id.
  return (OFFERING_NAMES as Record<string, string>)[id] ?? id;
}

/**
 * Upsert del override tocado sobre el overlay CRUDO (preserva los demás; el replace al bff es wholesale).
 * Omite el override si quedó en el DEFAULT del catálogo para no ensuciar la DB con valores iguales al código.
 *
 * BUGFIX (unlock de verticales): el "default" se compara contra el `defaultEnabled` REAL de la oferta, NO se
 * asume `enabled:true`. Antes, habilitar una VERTICAL (defaultEnabled:false) producía enabled:true que se
 * podaba como "redundante" → el override se perdía y la vertical seguía oculta (la feature pagable no
 * funcionaba). findOffering tolera ids desconocidos (oferta más nueva que el admin-web) → default conservador.
 */
export function withOverride(base: CatalogOverride[], next: CatalogOverride): CatalogOverride[] {
  const rest = base.filter((o) => o.id !== next.id);
  const defaultEnabled = findOffering(next.id)?.defaultEnabled ?? true;
  const isDefault =
    next.enabled === defaultEnabled &&
    next.mode === undefined &&
    next.multiplier === undefined &&
    next.minFareCents === undefined;
  return isDefault ? rest : [...rest, next];
}
