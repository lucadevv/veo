/**
 * Catálogo de tipos de documento que el conductor debe mantener vigentes para operar en Lima.
 * El `key` es el valor estable que viaja al backend (`AddDocumentRequest.type` y `DriverDocument.type`);
 * la etiqueta humana se resuelve por i18n en la capa de presentación con `documents.type.<key>`.
 *
 * El contrato declara `type` como string libre, así que toleramos tipos desconocidos (se muestran
 * con su valor crudo) sin romper la lista.
 */
export const DOCUMENT_TYPES = [
  'LICENSE_A1',
  'SOAT',
  'VEHICLE_REGISTRATION',
  'ITV',
  'CRIMINAL_RECORD',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Clave i18n del nombre legible de un tipo (`documents.type.<key>`), tolerante a desconocidos. */
export function documentTypeI18nKey(type: string): string {
  return `documents.type.${type}`;
}

/** `true` si el tipo pertenece al catálogo conocido de la app. */
export function isKnownDocumentType(type: string): type is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(type);
}
