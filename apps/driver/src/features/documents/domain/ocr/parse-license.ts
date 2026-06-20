/**
 * Parser PURO de la LICENCIA DE CONDUCIR peruana. Recibe las líneas OCR y devuelve número, categoría y
 * vencimiento de los que está razonablemente seguro. Ancla a palabras clave + formato; lo que no puede
 * anclar lo OMITE (degradación honesta — nunca inventa).
 *
 * Heurística (GROUND TRUTH, imágenes oficiales):
 *  - **Número**: rótulo real `Nro de Licencia`; formato `[A-Z]\d{8}` (ej. `Q70128450`). Se busca en la
 *    línea con "Licencia"/"N°"; si no hay etiqueta, el patrón de licencia más probable. Se prefiere la
 *    etiqueta para no confundir con el DNI (que también aparece).
 *  - **Categoría**: junto a "Categoría"/"CLASE", normalizada al catálogo tipado `LicenseCategory`.
 *  - **Vencimiento**: rótulo real `Fecha de Revalidacion` (NO "vence"/"válida hasta"). NO confundir con
 *    `Fecha de Expedicion` (emisión), que se excluye explícitamente.
 */

import { normalizePeruvianDate } from './ocr-date';
import { normalizeLicenseCategory } from './license-category';
import { canonicalize, lineMatchesAnyKeyword } from './ocr-text';
import type { ParsedLicense } from './parsed-document';

const NUMBER_KEYWORDS = ['nro de licencia', 'licencia', 'numero', 'n°', 'no.', 'license'] as const;
const CATEGORY_KEYWORDS = ['categoria', 'clase', 'category'] as const;
/**
 * GROUND TRUTH: el rótulo de vencimiento real es `Fecha de Revalidacion`. Se mantienen sinónimos defensivos
 * por si alguna variante/OCR usa otra palabra, pero "revalidacion" es el ancla principal.
 */
const EXPIRY_KEYWORDS = [
  'revalidacion',
  'fecha de revalidacion',
  'vencimiento',
  'caducidad',
  'valido hasta',
] as const;
/** Palabras clave que delatan que la fecha de la línea es de EMISIÓN/EXPEDICIÓN, no de revalidación (se excluye). */
const ISSUE_KEYWORDS = ['expedicion', 'emision', 'expedida'] as const;

/**
 * Número de licencia (GROUND TRUTH): letra de clase + 8 dígitos (`Q70128450`, formato `[A-Z]\d{8}`).
 * Devuelve el primer match plausible de una línea.
 */
function licenseNumberInLine(line: string): string | undefined {
  const compact = line.toUpperCase();
  const withLetter = /\b([A-Z]\d{8})\b/.exec(compact);
  return withLetter ? withLetter[1] : undefined;
}

/** Extrae el número de licencia, priorizando la línea etiquetada para no confundirlo con el DNI. */
function extractNumber(lines: readonly string[]): string | undefined {
  let fallback: string | undefined;
  for (const line of lines) {
    const candidate = licenseNumberInLine(line);
    if (!candidate) {
      continue;
    }
    if (lineMatchesAnyKeyword(canonicalize(line), NUMBER_KEYWORDS)) {
      return candidate;
    }
    fallback ??= candidate;
  }
  return fallback;
}

/** Extrae y normaliza la categoría a partir de la línea con "Categoría"/"Clase". */
function extractCategory(lines: readonly string[]): ParsedLicense['category'] {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    if (!lineMatchesAnyKeyword(canonicalize(line), CATEGORY_KEYWORDS)) {
      continue;
    }
    const sameLine = normalizeLicenseCategory(line);
    if (sameLine) {
      return sameLine;
    }
    const next = lines[i + 1];
    if (next) {
      const fromNext = normalizeLicenseCategory(next);
      if (fromNext) {
        return fromNext;
      }
    }
  }
  return undefined;
}

/** Extrae el vencimiento; ignora explícitamente las líneas de fecha de EMISIÓN/EXPEDICIÓN. */
function extractExpiry(lines: readonly string[]): string | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const canonical = canonicalize(line);
    if (lineMatchesAnyKeyword(canonical, ISSUE_KEYWORDS)) {
      continue;
    }
    if (!lineMatchesAnyKeyword(canonical, EXPIRY_KEYWORDS)) {
      continue;
    }
    const sameLine = normalizePeruvianDate(line);
    if (sameLine) {
      return sameLine;
    }
    const next = lines[i + 1];
    if (next) {
      const fromNext = normalizePeruvianDate(next);
      if (fromNext) {
        return fromNext;
      }
    }
  }
  return undefined;
}

/**
 * Parsea las líneas OCR de una licencia de conducir peruana. Devuelve solo los campos extraídos con
 * confianza; texto basura → `{}` (no inventa).
 */
export function parseLicense(lines: readonly string[]): ParsedLicense {
  const result: ParsedLicense = {};
  const number = extractNumber(lines);
  if (number) {
    result.number = number;
  }
  const category = extractCategory(lines);
  if (category) {
    result.category = category;
  }
  const expiresAt = extractExpiry(lines);
  if (expiresAt) {
    result.expiresAt = expiresAt;
  }
  return result;
}
