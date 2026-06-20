/**
 * Tipos de RESULTADO de los parsers de OCR. Cada documento extrae solo los campos de los que está
 * razonablemente seguro: TODOS son opcionales. Un campo ausente significa "el OCR no pudo extraerlo con
 * confianza" → la UI cae al tipeo manual. Los parsers NUNCA inventan un valor (degradación honesta).
 *
 * Las fechas (`birthDate`, `expiresAt`) viajan en el canónico `YYYY-MM-DD`; los demás campos como
 * vienen del documento (ya recortados/normalizados de espacios). La `category` de la licencia es la
 * unión tipada `LicenseCategory` (sin strings sueltos).
 */

import type { LicenseCategory } from './license-category';

/** Campos extraíbles del DNI peruano. */
export interface ParsedDni {
  /** Número de DNI: 8 dígitos. */
  documentNumber?: string;
  /** Nombre completo (apellidos + nombres) tal como figura en el documento. */
  fullName?: string;
  /** Fecha de nacimiento en `YYYY-MM-DD`. */
  birthDate?: string;
}

/** Campos extraíbles de la licencia de conducir peruana. */
export interface ParsedLicense {
  /** Número de la licencia. */
  number?: string;
  /** Categoría (clase A) normalizada al catálogo tipado. */
  category?: LicenseCategory;
  /** Fecha de vencimiento/revalidación en `YYYY-MM-DD`. */
  expiresAt?: string;
}

/** Campos extraíbles del SOAT. */
export interface ParsedSoat {
  /** Número de póliza. */
  policyNumber?: string;
  /** Fecha hasta la que la póliza está vigente, en `YYYY-MM-DD`. */
  expiresAt?: string;
}

/** Campos extraíbles de la tarjeta de propiedad vehicular. */
export interface ParsedPropertyCard {
  /** Placa del vehículo (formato peruano, p. ej. `ABC-123`). */
  plate?: string;
  /** Propietario (nombre o razón social) tal como figura en la tarjeta. */
  owner?: string;
}

/**
 * Unión discriminada del resultado del dispatcher `parseDocument`. El `kind` permite al consumidor
 * estrechar el tipo sin castear, y mapea 1:1 al tipo de documento del alta que se escaneó.
 */
export type ParsedDocument =
  | ({ kind: 'dni' } & ParsedDni)
  | ({ kind: 'license' } & ParsedLicense)
  | ({ kind: 'soat' } & ParsedSoat)
  | ({ kind: 'propertyCard' } & ParsedPropertyCard);
