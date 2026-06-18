import { FleetDocumentType } from '@veo/shared-types';

/**
 * Catálogo de tipos de documento que el conductor debe mantener vigentes para operar en Lima.
 * El `key` es el valor CANÓNICO que viaja al backend (`AddDocumentRequest.type`, `DriverDocument.type`
 * y el `type` del presign, validado con `@IsEnum(FleetDocumentType)`); por eso se toma directo del
 * enum `FleetDocumentType` de `@veo/shared-types` (sin strings mágicos: una deriva es error de
 * compilación, no un 400). La etiqueta humana se resuelve por i18n con `documents.type.<key>`.
 *
 * El contrato declara `type` como string libre, así que toleramos tipos desconocidos (se muestran
 * con su valor crudo) sin romper la lista.
 */
export const DOCUMENT_TYPES = [
  FleetDocumentType.LICENSE_A1,
  FleetDocumentType.SOAT,
  FleetDocumentType.PROPERTY_CARD,
  FleetDocumentType.ITV,
  FleetDocumentType.BACKGROUND_CHECK,
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
