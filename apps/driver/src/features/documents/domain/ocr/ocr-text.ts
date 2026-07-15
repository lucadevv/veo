/**
 * Utilidades PURAS de normalización del texto OCR. El reconocimiento on-device (Vision iOS / MLKit
 * Android) devuelve líneas crudas con ruido típico (acentos, mayúsculas inconsistentes, dobles
 * espacios, dígitos confundidos con letras). Estas funciones NO tienen estado ni efectos: reciben un
 * string y devuelven otro, de modo que los parsers que las usan sean triviales de testear.
 */

/**
 * Quita diacríticos (tildes, diéresis) de un texto. El OCR a veces pierde o agrega acentos, así que
 * para anclar por palabra clave ("Categoría" vs "Categoria") comparamos sin diacríticos. Usa la
 * descomposición canónica de Unicode (NFD) y elimina los marcos combinantes.
 */
export function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Forma CANÓNICA de una línea para BÚSQUEDA por palabra clave: sin diacríticos, en minúsculas y con
 * los espacios colapsados. NO se usa para extraer el valor (eso se hace sobre la línea original, que
 * conserva mayúsculas/formato), solo para detectar "¿esta línea menciona Nacimiento/Vencimiento/…?".
 */
export function canonicalize(value: string): string {
  return stripDiacritics(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Colapsa espacios internos y recorta los extremos, preservando mayúsculas/acentos del original. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Solo los dígitos de un texto (descarta separadores, letras y espacios). */
export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '');
}

/**
 * ¿La línea (canonicalizada) contiene alguna de las palabras clave dadas? Las keywords deben venir ya
 * canonicalizadas (minúsculas, sin acentos) para no recanonicalizar en cada llamada. Devuelve `false`
 * para una lista vacía (nunca un falso positivo).
 */
export function lineMatchesAnyKeyword(canonicalLine: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => keyword.length > 0 && canonicalLine.includes(keyword));
}
