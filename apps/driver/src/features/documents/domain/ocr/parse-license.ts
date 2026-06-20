/**
 * Parser PURO de la LICENCIA DE CONDUCIR peruana. Recibe las líneas OCR y devuelve número, categoría y
 * vencimiento de los que está razonablemente seguro. Ancla a palabras clave + formato; lo que no puede
 * anclar lo OMITE (degradación honesta — nunca inventa).
 *
 * Heurística (GROUND TRUTH, documento real verificado):
 *  - **Número**: rótulo real `Nro de Licencia`; formato `[A-Z]\d{6,12}` (ej. `F73694046` clase A = letra
 *    de departamento + DNI; clase B puede traer ubigeo intercalado → rango holgado). Se busca en la línea
 *    con "Licencia"/"N°"; si no hay etiqueta, el patrón de licencia más probable. Se prefiere la etiqueta
 *    para no confundir con el DNI (que también aparece).
 *  - **Categoría**: viene PARTIDA en dos rótulos del documento real: `Clase` (A/B) + `Categoría` (la
 *    PALABRA ordinal española `Uno`/`Dos`/`Tres`, con sub-letra opcional `Dos B`). GROUND TRUTH del OCR
 *    real: el layout es en COLUMNAS — los dos RÓTULOS van juntos (`Categoria`,`Clase`) y los dos VALORES
 *    juntos (`Uno`,`A`), y el ORDEN entre escaneos es INESTABLE. Por eso la proximidad rótulo→línea-
 *    siguiente NO sirve. Se usa un escaneo GLOBAL order-independent: se busca la línea que sea EXACTAMENTE
 *    la clase (`A`/`B`) y la que sea EXACTAMENTE el ordinal (`Uno`/`Dos B`/…), estén donde estén, y se
 *    COMBINAN a la canónica del catálogo tipado (`A` + `Uno` = `A-I`; `B` + `Dos B` = `B-IIb`). Como
 *    respaldo (otros layouts) se aceptan los rótulos inline (`Clase A`/`Categoría Uno`) y el formato YA
 *    combinado (`A-IIb`).
 *  - **Vencimiento**: rótulo real `Fecha de Revalidacion`. GROUND TRUTH del OCR real: las dos fechas
 *    (Expedición y Revalidación) vienen AGRUPADAS y en orden INESTABLE respecto a sus rótulos, así que el
 *    ancla por rótulo tampoco es confiable. PRIMARIO: la revalidación es SIEMPRE la fecha MÁS TARDÍA del
 *    anverso (expedición < revalidación) → se toma el MÁXIMO de todas las fechas `dd/mm/yyyy`. RESPALDO:
 *    el ancla por rótulo `revalidacion` (excluyendo `Fecha de Expedicion`) por si el max fallara.
 */

import { normalizePeruvianDate } from './ocr-date';
import {
  combineClassAndBody,
  combineClassAndCategory,
  lineIsCategoryOrdinal,
  lineIsLicenseClass,
  normalizeLicenseCategory,
  normalizeLicenseClass,
  type LicenseCategory,
  type LicenseClass,
} from './license-category';
import { canonicalize, collapseWhitespace, lineMatchesAnyKeyword } from './ocr-text';
import type { ParsedLicense } from './parsed-document';

const NUMBER_KEYWORDS = ['nro de licencia', 'licencia', 'numero', 'n°', 'no.', 'license'] as const;
/** Rótulo de la CLASE (`Clase: A`). Canonicalizado (sin tilde, minúscula). */
const CLASS_KEYWORDS = ['clase', 'class'] as const;
/** Rótulo de la CATEGORÍA (`Categoría: Uno`). Canonicalizado. */
const CATEGORY_KEYWORDS = ['categoria', 'category'] as const;
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
 * Número de licencia (GROUND TRUTH): 1 letra de departamento + dígitos. Clase A = letra + 8 díg (el DNI:
 * `F73694046`); clase B puede traer ubigeo intercalado y ser más larga → se relaja a `[A-Z]\d{6,12}`. El
 * `\b` inicial es tolerante (no falla si el OCR pega el valor al rótulo: el límite de palabra cae igual
 * entre el final del rótulo y la letra/dígito). Devuelve el primer match plausible de una línea.
 */
function licenseNumberInLine(line: string): string | undefined {
  const compact = line.toUpperCase();
  const withLetter = /\b([A-Z]\d{6,12})\b/.exec(compact);
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

/**
 * Devuelve el VALOR de un rótulo, tolerando la DISPERSIÓN del OCR (rótulo y valor en líneas distintas por
 * la rotación del anverso). Para cada línea que menciona alguna `keyword`:
 *  1. INLINE: intenta extraer el valor de la MISMA línea (tras `:` si lo hay, o la línea entera) con
 *     `pick`. Si `pick` reconoce algo → ese.
 *  2. LÍNEA SIGUIENTE: si el rótulo quedó solo, prueba `pick` sobre la línea de abajo.
 * Devuelve el primer valor que `pick` reconozca, o `undefined`.
 */
function valueForLabel<T>(
  lines: readonly string[],
  keywords: readonly string[],
  pick: (text: string) => T | null,
): T | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !lineMatchesAnyKeyword(canonicalize(line), keywords)) {
      continue;
    }
    const inlineSegment = line.includes(':')
      ? collapseWhitespace(line.slice(line.indexOf(':') + 1))
      : line;
    const inline = pick(inlineSegment);
    if (inline !== null) {
      return inline;
    }
    const next = lines[i + 1];
    if (next) {
      const fromNext = pick(next);
      if (fromNext !== null) {
        return fromNext;
      }
    }
  }
  return undefined;
}

/**
 * Escaneo GLOBAL order-independent (PRIMARIO para el layout en columnas del OCR real). Busca en TODAS las
 * líneas la que sea EXACTAMENTE la clase (`A`/`B`) y la que sea EXACTAMENTE el ordinal (`Uno`/`Dos B`/…),
 * sin importar dónde estén ni en qué orden, y las combina contra el catálogo tipado. Devuelve `null` si
 * no encuentra ambas o si la combinación no existe (degradación honesta — no inventa). NO usa proximidad
 * de rótulo: el OCR agrupa los rótulos por un lado y los valores por otro, así que la "línea siguiente"
 * a `Categoría` puede ser otro rótulo (`Clase`), no su valor.
 */
function extractCategoryGlobal(lines: readonly string[]): LicenseCategory | null {
  let licenseClass: LicenseClass | null = null;
  let body: { roman: string; suffix: string } | null = null;
  for (const line of lines) {
    if (line === undefined) {
      continue;
    }
    licenseClass ??= lineIsLicenseClass(line);
    body ??= lineIsCategoryOrdinal(line);
  }
  if (licenseClass && body) {
    return combineClassAndBody(licenseClass, body);
  }
  return null;
}

/**
 * Extrae la categoría. PRIMARIO: escaneo GLOBAL (clase exacta + ordinal exacto en cualquier línea,
 * order-independent — el layout real del OCR). RESPALDOS para otros layouts: (1) rótulos inline
 * (`Clase A` + `Categoría Uno`, tolerando valor en la línea siguiente), (2) la forma YA combinada
 * (`A-IIb`) en la línea de `Categoría`.
 */
function extractCategory(lines: readonly string[]): ParsedLicense['category'] {
  // PRIMARIO: layout en columnas (rótulos agrupados / valores agrupados, orden inestable).
  const global = extractCategoryGlobal(lines);
  if (global) {
    return global;
  }
  // RESPALDO 1: rótulos inline (`Clase A` / `Categoría Uno`), tolerando dispersión rótulo↔línea-siguiente.
  const licenseClass = valueForLabel<LicenseClass>(lines, CLASS_KEYWORDS, (text) =>
    normalizeLicenseClass(text),
  );
  if (licenseClass) {
    const combined = valueForLabel(lines, CATEGORY_KEYWORDS, (text) =>
      combineClassAndCategory(licenseClass, text),
    );
    if (combined) {
      return combined;
    }
  }
  // RESPALDO 2: sin rótulo `Clase` legible, intento la categoría ya combinada en la línea de `Categoría`.
  const standalone = valueForLabel(lines, CATEGORY_KEYWORDS, (text) =>
    normalizeLicenseCategory(text),
  );
  return standalone ?? undefined;
}

/**
 * PRIMARIO (layout real del OCR): la revalidación es SIEMPRE la fecha MÁS TARDÍA del anverso, porque el
 * único par de fechas es expedición < revalidación, y el OCR las agrupa en orden inestable respecto a sus
 * rótulos. Junta TODAS las fechas `dd/mm/yyyy` reconocibles (en cualquier línea) y devuelve el MÁXIMO en
 * ISO (`YYYY-MM-DD`, comparable lexicográficamente). Order-independent y robusto a la agrupación.
 */
function latestDate(lines: readonly string[]): string | undefined {
  let max: string | undefined;
  for (const line of lines) {
    if (line === undefined) {
      continue;
    }
    const iso = normalizePeruvianDate(line);
    if (iso && (max === undefined || iso > max)) {
      max = iso;
    }
  }
  return max;
}

/**
 * RESPALDO: ancla por rótulo `Fecha de Revalidacion`, ignorando explícitamente las líneas de
 * EMISIÓN/EXPEDICIÓN. Solo se usa si el primario (max-fecha) no encontró ninguna fecha.
 */
function expiryByLabel(lines: readonly string[]): string | undefined {
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
 * Extrae el vencimiento (revalidación). PRIMARIO: la fecha MÁS TARDÍA del anverso (max), robusta al orden
 * inestable y a la agrupación del OCR real. RESPALDO: ancla por rótulo `revalidacion`. Si no hay ninguna
 * fecha → `undefined` (degradación honesta, sin crash).
 */
function extractExpiry(lines: readonly string[]): string | undefined {
  return latestDate(lines) ?? expiryByLabel(lines);
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
