/**
 * Parser PURO de la TARJETA DE PROPIEDAD / TIVe vehicular peruana (SUNARP). Recibe las líneas OCR y
 * devuelve placa, marca, modelo, año de fabricación y la categoría vehicular MTC de las que está
 * razonablemente seguro. Ancla a formato (placa) + palabra clave con valor AL LADO tras `:`; lo que no
 * puede anclar lo OMITE (degradación honesta — nunca inventa).
 *
 * GROUND TRUTH (imágenes oficiales):
 *  - **Categoría**: está IMPRESA EXPLÍCITA (primer campo de "Datos del Vehículo"), valor AL LADO en la
 *    MISMA línea: `Categoría: M1`. Se captura con regex anclado `Categor[ií]a ... ([LMNO]\d[A-Z]*)`. NO se
 *    infiere por peso/asientos.
 *  - **Marca/Modelo/Año/Color/etc.**: valor AL LADO (misma línea, separado por `:`): `Marca:`, `Modelo:`,
 *    `Año de Fab.:`, `Color:`… OJO con tildes (`Categoría`) y abreviaturas con punto (`Año de Fab.:`).
 *  - **Placa**: bajo/junto a `Placa N°`, formato peruano 3 letras + 3 dígitos.
 *  - El QR es una URL de verificación SUNARP (no data) → NO se depende del QR.
 */

import { canonicalize, collapseWhitespace, lineMatchesAnyKeyword } from './ocr-text';
import type { ParsedPropertyCard } from './parsed-document';

const PLATE_KEYWORDS = ['placa', 'plate'] as const;
/** Etiqueta de la categoría MTC (con/sin tilde, canonicalizada sin diacríticos → "categoria"). */
const CATEGORY_KEYWORDS = ['categoria'] as const;
const MAKE_KEYWORDS = ['marca'] as const;
const MODEL_KEYWORDS = ['modelo'] as const;
/**
 * Año de FABRICACIÓN (`Año de Fab.:`) primero; `Año Modelo` (`ano modelo`) como FALLBACK cuando la TIVe
 * (p. ej. TIVe electrónica de moto) no imprime "Año de Fab." sino solo "Año Modelo". Canonicalizado.
 */
const YEAR_KEYWORDS = ['ano de fab', 'ano fab', 'ano de fabricacion'] as const;
const YEAR_FALLBACK_KEYWORDS = ['ano modelo'] as const;

/**
 * Patrones de placa peruana, en orden de preferencia, anclados a límites de palabra. Cada patrón captura
 * los dos grupos que se unen con guion para normalizar al canónico:
 *  - **MOTO/menor**: 3-4 dígitos + 2 letras (`7351-NB`, `123-AB`). El formato de las TIVe de moto.
 *  - **AUTO clásico**: 3 letras + 3 dígitos (`ABC-123`).
 *  - **AUTO nuevo**: letra + dígito + letra + 3 dígitos (`A1B-234`).
 * El guion del separador es OPCIONAL en el OCR (`7351NB`), por eso `-?`.
 */
const PLATE_PATTERNS: readonly RegExp[] = [
  /\b(\d{3,4})-?([A-Z]{2})\b/,
  /\b([A-Z]{3})-?(\d{3})\b/,
  /\b([A-Z]\d[A-Z])-?(\d{3})\b/,
];

/**
 * Líneas/tokens que parecen placa por accidente pero NO lo son (ruido de la TIVe). Si una línea matchea
 * alguno de estos, se DESCARTA como fuente de placa:
 *  - DUA/DAM: `118-2021-10-173280-26` (bloques numéricos largos con varios guiones).
 *  - Título: `1923911-2026` (7 díg + año).
 *  - Form. Rod.: `2X1` (no es placa, es relación de rodaje; lo descarta el patrón, pero por las dudas).
 * Se evalúa ANTES de buscar el patrón de placa en la línea.
 */
const PLATE_NOISE_PATTERNS: readonly RegExp[] = [
  /\b\d{3}-\d{4}-\d{1,2}-\d{4,}-\d{2}\b/, // DUA/DAM multi-bloque.
  /\b\d{7}-\d{4}\b/, // Título: 7 dígitos + año de 4.
];

/** Una placa por PATRÓN en la línea (probando los formatos en orden). Normaliza al canónico con guion. */
function plateInLine(line: string): string | undefined {
  const upper = line.toUpperCase();
  if (PLATE_NOISE_PATTERNS.some((noise) => noise.test(upper))) {
    return undefined;
  }
  for (const pattern of PLATE_PATTERNS) {
    const match = pattern.exec(upper);
    if (match?.[1] && match[2]) {
      return `${match[1]}-${match[2]}`;
    }
  }
  return undefined;
}

/**
 * Extrae la placa por PATRÓN (no por valor adyacente a la etiqueta — el OCR DISPERSA "Placa N°" y su valor
 * `7351-NB` en líneas separadas y no contiguas). Estrategia por confianza decreciente:
 *  1. La línea que menciona "Placa" trae el patrón → ese (máxima confianza, layout inline).
 *  2. La etiqueta "Placa" en una línea SIN patrón → se prioriza el primer candidato del resto del doc
 *     (el valor disperso). Si la etiqueta existe pero hay UN solo candidato en todo el doc, ese gana.
 *  3. Sin etiqueta: exactamente UN candidato en el doc → ese; varios ambiguos → se OMITE (no adivina).
 */
function extractPlate(lines: readonly string[]): string | undefined {
  const all = new Set<string>();
  let sawPlateLabel = false;
  for (const line of lines) {
    const isLabelLine = lineMatchesAnyKeyword(canonicalize(line), PLATE_KEYWORDS);
    const plate = plateInLine(line);
    if (plate && isLabelLine) {
      return plate;
    }
    if (isLabelLine) {
      sawPlateLabel = true;
    }
    if (plate) {
      all.add(plate);
    }
  }
  if (all.size === 1) {
    return [...all][0];
  }
  // Hay etiqueta "Placa" pero el valor quedó disperso entre varios candidatos: tomamos el primero (la
  // presencia de la etiqueta confirma que el doc ES una tarjeta con placa; el primer formato de moto/auto
  // que apareció es el más probable). Sin etiqueta y con ambigüedad, NO adivina.
  return sawPlateLabel && all.size > 1 ? [...all][0] : undefined;
}

/**
 * Valor AL LADO de una etiqueta tras `:` en la MISMA línea (layout de la TIVe). El keyword se busca en el
 * SEGMENTO de la ETIQUETA (lo que está ANTES del `:`), no en el valor — así `Modelo:` no se confunde con
 * `Año Modelo:` (cuya etiqueta es "ano modelo", que no es la keyword "modelo" exacta) ni con un valor que
 * casualmente contenga la palabra. Si la etiqueta no trae `:` o no hay nada después, devuelve `undefined`
 * (la TIVe pone el valor inline, no en la línea de abajo).
 */
function inlineValueForLabel(
  lines: readonly string[],
  keywords: readonly string[],
): string | undefined {
  for (const line of lines) {
    if (!line.includes(':')) {
      continue;
    }
    // Etiqueta = lo que está antes del `:`, canonicalizada y sin puntos (abreviaturas `Año de Fab.`).
    const labelSegment = canonicalize(line.slice(0, line.indexOf(':'))).replace(/\./g, '').trim();
    // Match EXACTO de la etiqueta: evita que "ano modelo" matchee la keyword "modelo".
    if (!keywords.some((k) => labelSegment === k)) {
      continue;
    }
    const value = collapseWhitespace(line.slice(line.indexOf(':') + 1));
    if (value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Extrae el código de categoría MTC impreso explícito (`Categoría: M1`). Ancla a la etiqueta y captura el
 * código `[LMNO]\d[A-Z]*` (admite sufijos como `SC` de especiales). Devuelve el código en mayúsculas o
 * `undefined` si la etiqueta no trae un código válido al lado.
 */
function extractMtcCategory(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (!lineMatchesAnyKeyword(canonicalize(line), CATEGORY_KEYWORDS)) {
      continue;
    }
    const match = /\b([LMNO]\d[A-Z]*)\b/.exec(line.toUpperCase());
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

/** Extrae el primer año plausible (1950–2099) de un valor crudo, o `undefined`. */
function yearFromValue(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const match = /\b(19[5-9]\d|20\d\d)\b/.exec(raw);
  return match?.[1] ? Number(match[1]) : undefined;
}

/**
 * Año del vehículo: prioriza `Año de Fab.:`; si la TIVe no lo imprime (p. ej. la electrónica de moto trae
 * solo `Año Modelo : 2021`), cae al FALLBACK `Año Modelo`. Valor de 4 dígitos plausibles al lado tras `:`.
 */
function extractYear(lines: readonly string[]): number | undefined {
  return (
    yearFromValue(inlineValueForLabel(lines, YEAR_KEYWORDS)) ??
    yearFromValue(inlineValueForLabel(lines, YEAR_FALLBACK_KEYWORDS))
  );
}

/**
 * Parsea las líneas OCR de una tarjeta de propiedad / TIVe peruana. Devuelve solo lo que extrajo con
 * confianza; texto basura → `{}` (no inventa).
 */
export function parsePropertyCard(lines: readonly string[]): ParsedPropertyCard {
  const result: ParsedPropertyCard = {};

  const plate = extractPlate(lines);
  if (plate) {
    result.plate = plate;
  }
  const make = inlineValueForLabel(lines, MAKE_KEYWORDS);
  if (make) {
    result.make = make;
  }
  const model = inlineValueForLabel(lines, MODEL_KEYWORDS);
  if (model) {
    result.model = model;
  }
  const year = extractYear(lines);
  if (year !== undefined) {
    result.year = year;
  }
  const mtcCategory = extractMtcCategory(lines);
  if (mtcCategory) {
    result.mtcCategory = mtcCategory;
  }
  return result;
}
