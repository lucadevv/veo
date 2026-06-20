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
 * Forma CANÓNICA de la ETIQUETA de una línea para el match EXACTO: lo que está ANTES del `:` (o la línea
 * entera si no hay `:`, caso "etiqueta sola"), canonicalizada y sin puntos (abreviaturas `Año de Fab.`).
 * Se usa tanto para detectar la etiqueta buscada como para reconocer que la línea SIGUIENTE es OTRA
 * etiqueta conocida (y por tanto NO un valor disperso).
 */
function labelKeyOf(line: string): string {
  const head = line.includes(':') ? line.slice(0, line.indexOf(':')) : line;
  return canonicalize(head).replace(/\./g, '').trim();
}

/**
 * TODAS las etiquetas por-campo conocidas de la TIVe (canónicas, sin tilde, sin punto). Sirve de GUARDA
 * del fallback "etiqueta sola → valor en la línea siguiente": una línea cuyo `labelKeyOf` calza alguna de
 * estas ES una etiqueta vecina (p. ej. "Año Modelo" debajo de "Modelo"), NUNCA un valor disperso. El
 * matching es EXACTO (igualdad), no `includes`, igual que el de los campos — sin strings mágicos de dominio.
 */
const ALL_KNOWN_LABELS: readonly string[] = [
  ...PLATE_KEYWORDS,
  ...CATEGORY_KEYWORDS,
  ...MAKE_KEYWORDS,
  ...MODEL_KEYWORDS,
  ...YEAR_KEYWORDS,
  ...YEAR_FALLBACK_KEYWORDS,
];

/** ¿El `labelKeyOf` de la línea calza EXACTO alguna etiqueta conocida (es una etiqueta vecina)? */
function isKnownLabelLine(line: string): boolean {
  const key = labelKeyOf(line);
  return key.length > 0 && ALL_KNOWN_LABELS.some((label) => key === label);
}

/**
 * Valor de una etiqueta por-campo, tolerante a la DISPERSIÓN del OCR del device (PDF en pantalla):
 *  1. INLINE (layout nominal de la TIVe): la etiqueta trae el valor en la MISMA línea tras `:`
 *     (`Modelo: YARIS`). El keyword se busca en el SEGMENTO de la ETIQUETA (antes del `:`), match EXACTO,
 *     así `Modelo:` no se confunde con `Año Modelo:` ni con un valor que casualmente contenga la palabra.
 *  2. LÍNEA SIGUIENTE (fallback de dispersión): la etiqueta queda SOLA (sin `:`, o con `:` vacío) y el
 *     valor cae en la línea de ABAJO (`Modelo` / `RC 200`). Se toma esa línea SIEMPRE que NO sea otra
 *     etiqueta conocida (evita capturar "Año Modelo" como valor de "Modelo", etc.).
 * Si ni el inline ni la línea siguiente aportan un valor, devuelve `undefined` (degradación honesta).
 */
function inlineValueForLabel(
  lines: readonly string[],
  keywords: readonly string[],
): string | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Match EXACTO de la etiqueta (sobre el segmento antes del `:`, o la línea entera si no hay `:`).
    if (!keywords.some((k) => labelKeyOf(line) === k)) {
      continue;
    }
    // (1) Valor INLINE tras `:` en la misma línea.
    if (line.includes(':')) {
      const inline = collapseWhitespace(line.slice(line.indexOf(':') + 1));
      if (inline.length > 0) {
        return inline;
      }
    }
    // (2) Etiqueta SOLA (sin `:` o con `:` vacío) → valor en la línea SIGUIENTE, salvo que esa línea sea
    // otra etiqueta conocida (falso positivo) o esté vacía.
    const next = lines[i + 1];
    if (next !== undefined && !isKnownLabelLine(next)) {
      const value = collapseWhitespace(next);
      if (value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Extrae el código de categoría MTC impreso explícito (`Categoría: M1`). Ancla a la etiqueta y captura el
 * código `[LMNO]\d[A-Z]*` (admite sufijos como `SC` de especiales). Tolera la DISPERSIÓN del OCR: si la
 * etiqueta "Categoría" trae el código en su MISMA línea lo toma; si la etiqueta queda SOLA, busca el código
 * en la línea SIGUIENTE (salvo que esa línea sea otra etiqueta conocida). Devuelve el código en mayúsculas o
 * `undefined` si no encuentra un código válido.
 */
function extractMtcCategory(lines: readonly string[]): string | undefined {
  const codeIn = (text: string): string | undefined => {
    const match = /\b([LMNO]\d[A-Z]*)\b/.exec(text.toUpperCase());
    return match?.[1];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!lineMatchesAnyKeyword(canonicalize(line), CATEGORY_KEYWORDS)) {
      continue;
    }
    // (1) Código en la MISMA línea de la etiqueta (inline).
    const inline = codeIn(line);
    if (inline) {
      return inline;
    }
    // (2) Etiqueta SOLA → código en la línea SIGUIENTE, salvo que sea otra etiqueta conocida.
    const next = lines[i + 1];
    if (next !== undefined && !isKnownLabelLine(next)) {
      const fromNext = codeIn(next);
      if (fromNext) {
        return fromNext;
      }
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
