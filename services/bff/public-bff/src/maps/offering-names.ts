/**
 * Resolución SERVER-SIDE del nombre visible de cada oferta (ADR 013): el quote SIGUE mandando
 * `name` resuelto para apps viejas (compat); las apps nuevas resuelven `options[].labelKey` en su
 * propio i18n. Esto NO es la tabla de pricing (esa vive en el catálogo de @veo/shared-types):
 * es la traducción es-PE del token de la oferta, responsabilidad del borde público.
 *
 * `Record<OfferingId, string>` exhaustivo: una oferta nueva en el catálogo sin nombre acá NO compila.
 */
import { OfferingId } from '@veo/shared-types';

export const OFFERING_DISPLAY_NAMES: Record<OfferingId, string> = {
  [OfferingId.VEO_MOTO]: 'VEO Moto',
  [OfferingId.VEO_ECONOMICO]: 'VEO Económico',
  // F2.3 (ADR-017 §1.2) · Confort renombrado a "Normal" (solo el nombre; el id veo_confort es contrato).
  [OfferingId.VEO_CONFORT]: 'VEO Normal',
  [OfferingId.VEO_XL]: 'VEO XL',
  [OfferingId.VEO_PREMIUM]: 'VEO Premium',
  // B5-4 · verticales especiales: codeadas pero ocultas (defaultEnabled:false). El nombre existe
  // para cuando el admin las habilite (el quote no las cotiza mientras estén deshabilitadas).
  [OfferingId.VEO_AMBULANCE]: 'VEO Ambulancia',
  [OfferingId.VEO_TOW]: 'VEO Grúa',
  [OfferingId.VEO_MECHANIC]: 'VEO Mecánico',
};
