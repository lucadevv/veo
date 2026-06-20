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
 * Modo de CAPTURA del binario, tipado (sin string suelto). Decide la SUPERFICIE de captura y el framing
 * del sheet, no el pipeline de subida (que es el mismo para ambos):
 *  - `'document'`: el binario ES un documento con bordes (licencia/SOAT/tarjeta/DNI). Acción principal =
 *    escáner nativo (bordes + auto-captura + corrección + OCR). Copy/iconografía de "documento".
 *  - `'photo'`: el binario es una FOTO LIBRE (la foto del vehículo). Acción principal = cámara normal
 *    (sin escáner de bordes ni OCR). Galería como secundaria. Copy/iconografía de "foto".
 * Es un union cerrado: un tipo nuevo debe declarar su modo en el `Record` (no hay default silencioso).
 */
export type RegistrationDocumentCaptureMode = 'document' | 'photo';

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
  /**
   * Superficie de captura del binario para este tipo. `'document'` = escáner de bordes + OCR (copy de
   * documento); `'photo'` = cámara normal de foto libre (copy de foto, sin escáner ni OCR). El upload es
   * el MISMO en ambos modos: solo cambia la captura y el framing (copy/ícono).
   */
  readonly captureMode: RegistrationDocumentCaptureMode;
  /**
   * `true` si el documento tiene NÚMERO (licencia/SOAT/tarjeta). La foto del vehículo (VEHICLE_PHOTO)
   * NO lo tiene: el sheet oculta el campo y NO lo exige. La validación del número es contextual por tipo
   * (espeja el `@ValidateIf` del backend) — la foto se registra sin `documentNumber`.
   */
  readonly hasNumber: boolean;
  /** Clave i18n de la etiqueta del campo de número (propia del tipo). Solo si `hasNumber`. */
  readonly numberLabelKey?: string;
  /** Clave i18n del placeholder del campo de número (propia del tipo). Solo si `hasNumber`. */
  readonly numberPlaceholderKey?: string;
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
    captureMode: 'document',
    hasNumber: true,
    numberLabelKey: 'registration.documents.number.LICENSE_A1.label',
    numberPlaceholderKey: 'registration.documents.number.LICENSE_A1.placeholder',
    // La licencia de conducir vence.
    hasExpiry: true,
  },
  [FleetDocumentType.SOAT]: {
    captureMode: 'document',
    hasNumber: true,
    numberLabelKey: 'registration.documents.number.SOAT.label',
    numberPlaceholderKey: 'registration.documents.number.SOAT.placeholder',
    // El SOAT vence.
    hasExpiry: true,
  },
  [FleetDocumentType.PROPERTY_CARD]: {
    captureMode: 'document',
    hasNumber: true,
    numberLabelKey: 'registration.documents.number.PROPERTY_CARD.label',
    numberPlaceholderKey: 'registration.documents.number.PROPERTY_CARD.placeholder',
    // La tarjeta de propiedad NO vence en Perú: no se pide vencimiento ni se envía `expiresAt`.
    hasExpiry: false,
  },
  [FleetDocumentType.VEHICLE_PHOTO]: {
    // La foto del vehículo es una FOTO LIBRE (no un documento con bordes): cámara normal, sin escáner ni
    // OCR. Copy/ícono de foto. SIN número y SIN vencimiento; solo la captura. Se registra sin
    // `documentNumber` (validación contextual por tipo, espeja el backend).
    captureMode: 'photo',
    hasNumber: false,
    hasExpiry: false,
  },
  [FleetDocumentType.DNI]: {
    captureMode: 'document',
    // El DNI tiene NÚMERO (8 dígitos). Se sube como documento de 2 caras (FRONT+BACK vía el presign
    // múltiple del 3A); la cara FRONT es la que consume el face-match (sub-lote 3C).
    hasNumber: true,
    numberLabelKey: 'registration.documents.number.DNI.label',
    numberPlaceholderKey: 'registration.documents.number.DNI.placeholder',
    // El DNI peruano vence, pero el vencimiento queda FUERA de alcance de este sub-lote (el OCR del DNI
    // está diferido): en el alta lo tratamos como no-vencedor y NO exigimos `expiresAt`.
    hasExpiry: false,
  },
};
