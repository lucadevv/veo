/**
 * Dispatcher TIPADO de parsers de OCR. Rutea las líneas de texto al parser correcto según el
 * `FleetDocumentType` CANÓNICO (el enum de `@veo/shared-types`, NUNCA un string suelto). Mantiene la
 * extracción desacoplada de la presentación: la UI pasa el tipo del documento que escaneó y recibe los
 * campos extraídos, sin saber qué parser concreto corrió.
 *
 * Cobertura HOY: `LICENSE_A1`, `SOAT`, `PROPERTY_CARD` (paso 3 · Documentos) y `DNI` (paso 1 · Datos
 * Personales · sub-lote 3B). El DNI se escanea (anverso + reverso) y `parseDni` prellena los datos
 * personales del wizard a partir del texto OCR del FRENTE; aquí se enruta como cualquier otro tipo.
 */

import { FleetDocumentType } from '@veo/shared-types';
import type { RegistrationFleetDocumentType } from '../../../registration/domain';
import { parseDni } from './parse-dni';
import { parseLicense } from './parse-license';
import { parseSoat } from './parse-soat';
import { parsePropertyCard } from './parse-property-card';
import type { ParsedDocument } from './parsed-document';

/**
 * Tipos de documento del alta que TIENEN parser de OCR. Es el subconjunto de
 * `RegistrationFleetDocumentType` que se escanea como documento con texto legible (licencia/SOAT/
 * tarjeta). La FOTO del vehículo (`VEHICLE_PHOTO`) NO se parsea (es solo una imagen, sin campos), por eso
 * queda fuera del union — pedirle un parse es un error de compilación, no un parse vacío silencioso.
 */
export type ParsableDocumentType = Exclude<
  RegistrationFleetDocumentType,
  typeof FleetDocumentType.VEHICLE_PHOTO
>;

/**
 * Rutea las líneas OCR al parser del tipo dado y devuelve un `ParsedDocument` discriminado por `kind`.
 * El `switch` es EXHAUSTIVO sobre `ParsableDocumentType` (sin `default`): si mañana se agrega un tipo
 * parseable al alta, este dispatcher deja de compilar hasta que se le defina su ruta — el tipo nuevo es
 * un prompt en tiempo de compilación, no un olvido silencioso. Cada parser ya degrada honestamente
 * (devuelve solo lo que extrajo), así que un documento ilegible produce un resultado con solo `kind`.
 */
export function parseDocument(
  type: ParsableDocumentType,
  lines: readonly string[],
): ParsedDocument {
  switch (type) {
    case FleetDocumentType.LICENSE_A1:
      return { kind: 'license', ...parseLicense(lines) };
    case FleetDocumentType.SOAT:
      return { kind: 'soat', ...parseSoat(lines) };
    case FleetDocumentType.PROPERTY_CARD:
      return { kind: 'propertyCard', ...parsePropertyCard(lines) };
    case FleetDocumentType.DNI:
      return { kind: 'dni', ...parseDni(lines) };
  }
}

/**
 * Type guard: ¿el tipo del alta es uno que el dispatcher sabe parsear? Filtra `VEHICLE_PHOTO` (que no se
 * parsea). Permite que la presentación decida si intentar el auto-llenado sin castear.
 */
export function isParsableDocumentType(
  type: RegistrationFleetDocumentType,
): type is ParsableDocumentType {
  return type !== FleetDocumentType.VEHICLE_PHOTO;
}
