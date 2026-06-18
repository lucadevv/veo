import { FleetDocumentType } from '@veo/shared-types';
import type { RegistrationFleetDocumentType } from '../../domain';

/**
 * Tipos de documento del ALTA que el sheet de captura sabe configurar: el subconjunto canónico de
 * `FleetDocumentType` del paso 3 (licencia + SOAT + tarjeta de propiedad). Reusa el tipo del dominio
 * (`RegistrationFleetDocumentType`, el rango EXACTO de `registrationDocTypeToBackend`) para que la
 * config y el mapeo no puedan derivar entre sí.
 */
export type RegistrationDocumentFormType = RegistrationFleetDocumentType;

/**
 * Configuración CONTEXTUAL del formulario por tipo de documento. El sheet pide SOLO los campos que
 * aplican a cada tipo (la foto es la fuente de verdad; no se piden aseguradora/categoría/placa):
 *  - `numberLabelKey` / `numberPlaceholderKey`: claves i18n del campo de número, propias del tipo.
 *  - `hasExpiry`: si el documento VENCE. La licencia y el SOAT vencen; la tarjeta de propiedad NO
 *    vence en Perú, así que para `PROPERTY_CARD` el `DateField` ni se muestra ni se exige, y el alta
 *    se envía SIN `expiresAt` (el contrato `addDocumentRequest.expiresAt` es opcional; fleet lo
 *    guarda nullable — sin cambio de backend).
 */
export interface RegistrationDocumentFormConfig {
  /** Clave i18n de la etiqueta del campo de número (propia del tipo). */
  readonly numberLabelKey: string;
  /** Clave i18n del placeholder del campo de número (propia del tipo). */
  readonly numberPlaceholderKey: string;
  /** `true` si el documento vence: el `DateField` de vencimiento se muestra y se exige. */
  readonly hasExpiry: boolean;
}

/**
 * Mapa TIPADO y EXHAUSTIVO (keyed por `RegistrationDocumentFormType`): describe el formulario de cada
 * tipo de documento del alta. Si mañana se agrega un nuevo tipo de documento del alta al union, este
 * `Record` deja de compilar hasta que se le defina su config — el nuevo tipo es un prompt en tiempo de
 * compilación, no un olvido silencioso.
 */
export const REGISTRATION_DOCUMENT_FORM_CONFIG: Record<
  RegistrationDocumentFormType,
  RegistrationDocumentFormConfig
> = {
  [FleetDocumentType.LICENSE_A1]: {
    numberLabelKey: 'registration.documents.number.LICENSE_A1.label',
    numberPlaceholderKey: 'registration.documents.number.LICENSE_A1.placeholder',
    // La licencia de conducir vence.
    hasExpiry: true,
  },
  [FleetDocumentType.SOAT]: {
    numberLabelKey: 'registration.documents.number.SOAT.label',
    numberPlaceholderKey: 'registration.documents.number.SOAT.placeholder',
    // El SOAT vence.
    hasExpiry: true,
  },
  [FleetDocumentType.PROPERTY_CARD]: {
    numberLabelKey: 'registration.documents.number.PROPERTY_CARD.label',
    numberPlaceholderKey: 'registration.documents.number.PROPERTY_CARD.placeholder',
    // La tarjeta de propiedad NO vence en Perú: no se pide vencimiento ni se envía `expiresAt`.
    hasExpiry: false,
  },
};
