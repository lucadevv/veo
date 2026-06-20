/**
 * MAPPER del resultado de los parsers de OCR (`ParsedDni`/`ParsedSoat`/`ParsedLicense`) a la variante
 * EXACTA de `ExtractedDocumentData` que el contrato del backend acepta (Lote 1 · onboarding sin-formularios).
 *
 * Por qué existe (degradación honesta campo a campo): los parsers ya devuelven solo lo que el OCR pudo
 * anclar con confianza (todos sus campos opcionales). El mapper:
 *  1. Discrimina por `FleetDocumentType` (NUNCA un string suelto) → fija el `type` correcto de la unión.
 *  2. TRADUCE los nombres divergentes parser↔contrato:
 *       - `ParsedDni.birthDate`  (camelCase D) → `ExtractedDniData.birthdate`  (minúscula, contrato).
 *       - `ParsedLicense.number`                → `ExtractedLicenseA1Data.documentNumber`.
 *  3. OMITE cada campo `undefined` (spread condicional): un OCR parcial produce un objeto parcial VÁLIDO;
 *     nunca se inyecta una clave con `undefined` (el backend usa `forbidNonWhitelisted`, pero además un
 *     objeto sin la clave es lo honesto: "no se leyó" ≠ "se leyó vacío").
 *  4. MAPEA la categoría de la licencia (`ParsedLicense.category` → `ExtractedLicenseA1Data.category`): el
 *     contrato ya la admite (clase A auto / clase B moto, canónica), para validar elegibilidad auto/moto en
 *     el backend a futuro. Es conveniencia (no dato crítico); se omite si el OCR no la pudo leer.
 *
 * El retorno está tipado a la VARIANTE exacta (no a la unión), así que el discriminante y los campos
 * quedan verificados en compilación contra el contrato de @veo/api-client.
 */

import { FleetDocumentType } from '@veo/shared-types';
import type {
  ExtractedDniData,
  ExtractedLicenseA1Data,
  ExtractedPropertyCardData,
  ExtractedSoatData,
} from '@veo/api-client';
import type {
  ParsedDni,
  ParsedLicense,
  ParsedPropertyCard,
  ParsedSoat,
} from './parsed-document';

/** DNI → `ExtractedDniData`. Traduce `birthDate`→`birthdate`; omite los campos que el OCR no extrajo. */
export function parsedDniToExtracted(p: ParsedDni): ExtractedDniData {
  return {
    type: FleetDocumentType.DNI,
    ...(p.fullName ? { fullName: p.fullName } : {}),
    ...(p.documentNumber ? { documentNumber: p.documentNumber } : {}),
    ...(p.birthDate ? { birthdate: p.birthDate } : {}),
  };
}

/** SOAT → `ExtractedSoatData`. Nombres alineados (`policyNumber`/`expiresAt`); omite lo no extraído. */
export function parsedSoatToExtracted(p: ParsedSoat): ExtractedSoatData {
  return {
    type: FleetDocumentType.SOAT,
    ...(p.policyNumber ? { policyNumber: p.policyNumber } : {}),
    ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
  };
}

/**
 * Licencia → `ExtractedLicenseA1Data`. Traduce `number`→`documentNumber`; MAPEA `category` (clase A auto /
 * clase B moto, canónica); omite los campos que el OCR no extrajo.
 */
export function parsedLicenseToExtracted(p: ParsedLicense): ExtractedLicenseA1Data {
  return {
    type: FleetDocumentType.LICENSE_A1,
    ...(p.number ? { documentNumber: p.number } : {}),
    ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
    ...(p.category ? { category: p.category } : {}),
  };
}

/**
 * Tarjeta de propiedad / TIVe → `ExtractedPropertyCardData` (Lote 2). Nombres alineados con el contrato
 * (`plate`/`make`/`model`/`year`/`mtcCategory`); omite los campos que el OCR no extrajo. La categoría MTC
 * viaja como el CÓDIGO crudo (`M1`/`N1`/…): el mapeo a `VehicleType` es decisión del flujo de alta
 * (`mapMtcCategoryToVehicleType`), no del transporte de datos al backend.
 */
export function parsedPropertyCardToExtracted(p: ParsedPropertyCard): ExtractedPropertyCardData {
  return {
    type: FleetDocumentType.PROPERTY_CARD,
    ...(p.plate ? { plate: p.plate } : {}),
    ...(p.make ? { make: p.make } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.year !== undefined ? { year: p.year } : {}),
    ...(p.mtcCategory ? { mtcCategory: p.mtcCategory } : {}),
  };
}
