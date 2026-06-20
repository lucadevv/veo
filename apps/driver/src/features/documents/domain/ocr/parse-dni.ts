/**
 * Parser PURO del DNI peruano (Documento Nacional de Identidad) a partir de las líneas de texto que el
 * OCR on-device reconoce. NO tiene estado ni efectos: recibe `lines` y devuelve los campos de los que
 * está razonablemente seguro. Lo que no puede anclar con confianza, lo OMITE (degradación honesta).
 *
 * Heurística (anclada a formato + palabras clave, no a posición fija, que el OCR no garantiza):
 *  - **Número**: 8 dígitos exactos. El DNI peruano tiene 8 dígitos; pero un DNI lleva OTROS números de
 *    8 dígitos posibles (no es lo normal) y muchos de longitudes distintas. Se prioriza el 8-dígitos que
 *    está en una línea con la etiqueta "DNI"; si no hay etiqueta, se toma el ÚNICO 8-dígitos del
 *    documento (si hay exactamente uno → alta confianza). Varios candidatos ambiguos sin etiqueta → se
 *    omite (no se adivina).
 *  - **Fecha de nacimiento**: la fecha en/junto a la línea con "Nacimiento"/"FECHA DE NACIMIENTO".
 *  - **Nombre**: apellidos + nombres anclados a sus etiquetas ("Apellidos"/"Pre Nombres"/"Nombres").
 */

import { normalizePeruvianDate } from './ocr-date';
import { canonicalize, collapseWhitespace, lineMatchesAnyKeyword } from './ocr-text';
import type { ParsedDni } from './parsed-document';

/** Palabras clave (canonicalizadas) que anclan el número de DNI. */
const DNI_NUMBER_KEYWORDS = ['dni', 'documento nacional'] as const;
/** Palabras clave que anclan la fecha de nacimiento. */
const BIRTH_KEYWORDS = ['nacimiento', 'fecha de nacimiento', 'birth'] as const;
/** Palabras clave de la etiqueta de apellidos. */
const SURNAME_KEYWORDS = ['apellidos', 'apellido paterno', 'pre apellido'] as const;
/** Palabras clave de la etiqueta de nombres. */
const GIVEN_NAME_KEYWORDS = ['pre nombres', 'prenombres', 'nombres'] as const;

/** Todas las apariciones de un grupo de 8 dígitos EXACTOS en una línea (no 7 ni 9). */
function eightDigitMatches(line: string): string[] {
  return line.match(/(?<!\d)\d{8}(?!\d)/g) ?? [];
}

/**
 * Extrae el número de DNI (8 dígitos). Estrategia por confianza decreciente:
 *  1. Si una línea menciona "DNI"/"Documento nacional" Y contiene un 8-dígitos → ese (máxima confianza).
 *  2. Si en TODO el documento hay exactamente UN 8-dígitos → ese (no hay ambigüedad).
 *  3. Si hay varios 8-dígitos y ninguno con etiqueta → se OMITE (no se adivina cuál es el DNI).
 */
function extractDocumentNumber(lines: readonly string[]): string | undefined {
  const allEightDigit: string[] = [];
  for (const line of lines) {
    const matches = eightDigitMatches(line);
    if (matches.length === 0) {
      continue;
    }
    if (lineMatchesAnyKeyword(canonicalize(line), DNI_NUMBER_KEYWORDS)) {
      return matches[0];
    }
    allEightDigit.push(...matches);
  }
  return allEightDigit.length === 1 ? allEightDigit[0] : undefined;
}

/**
 * Extrae la fecha de nacimiento. Busca la línea con la etiqueta de nacimiento y normaliza la primera
 * fecha que contenga; si la etiqueta y la fecha quedaron en líneas distintas, prueba la línea siguiente.
 */
function extractBirthDate(lines: readonly string[]): string | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    if (!lineMatchesAnyKeyword(canonicalize(line), BIRTH_KEYWORDS)) {
      continue;
    }
    const sameLine = normalizePeruvianDate(line);
    if (sameLine) {
      return sameLine;
    }
    const next = lines[i + 1];
    if (next) {
      const nextLine = normalizePeruvianDate(next);
      if (nextLine) {
        return nextLine;
      }
    }
  }
  return undefined;
}

/** Toma el valor a la derecha de una etiqueta dentro de la misma línea (o la línea siguiente). */
function valueForLabel(
  lines: readonly string[],
  index: number,
  keywords: readonly string[],
): string | undefined {
  const line = lines[index];
  if (line === undefined) {
    return undefined;
  }
  if (!lineMatchesAnyKeyword(canonicalize(line), keywords)) {
    return undefined;
  }
  // El valor suele ir tras un `:` en la misma línea; si no, en la línea de abajo.
  const afterColon = line.includes(':') ? line.slice(line.indexOf(':') + 1) : '';
  const inline = collapseWhitespace(afterColon);
  if (inline.length > 0) {
    return inline;
  }
  const next = lines[index + 1];
  return next ? collapseWhitespace(next) || undefined : undefined;
}

/**
 * Compone el nombre completo a partir de las etiquetas de apellidos y nombres. Si solo una está
 * presente, devuelve esa; si ninguna ancla, OMITE (no arma un nombre con líneas al azar).
 */
function extractFullName(lines: readonly string[]): string | undefined {
  let surnames: string | undefined;
  let givenNames: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    surnames ??= valueForLabel(lines, i, SURNAME_KEYWORDS);
    givenNames ??= valueForLabel(lines, i, GIVEN_NAME_KEYWORDS);
  }
  const parts = [surnames, givenNames].filter((part): part is string => !!part && part.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  return collapseWhitespace(parts.join(' '));
}

/**
 * Parsea las líneas OCR de un DNI peruano. Devuelve SOLO los campos extraídos con confianza; los que no
 * pudo anclar quedan ausentes (la UI cae al tipeo manual). Texto basura → objeto vacío `{}` (no inventa).
 */
export function parseDni(lines: readonly string[]): ParsedDni {
  const result: ParsedDni = {};
  const documentNumber = extractDocumentNumber(lines);
  if (documentNumber) {
    result.documentNumber = documentNumber;
  }
  const fullName = extractFullName(lines);
  if (fullName) {
    result.fullName = fullName;
  }
  const birthDate = extractBirthDate(lines);
  if (birthDate) {
    result.birthDate = birthDate;
  }
  return result;
}
