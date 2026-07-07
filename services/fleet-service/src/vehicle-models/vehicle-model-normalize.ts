/**
 * LOTE 3 · normalización de marca/modelo para el FUZZY-MATCH del catálogo.
 *
 * DEBE producir EXACTAMENTE el mismo resultado que las columnas generadas `make_norm`/`model_norm` de
 * `vehicle_model_specs` (migración 20260620140000): upper + trim + colapso de espacios internos + sin tildes.
 * El lado SQL usa `upper(regexp_replace(trim(translate(col, tildes, ascii)), '\s+', ' ', 'g'))`; acá lo
 * replicamos en TS para parametrizar el `$queryRaw` con el MISMO texto contra el que se construyó el índice
 * GIN trigram (si divergieran, el cliente buscaría algo que el índice no contiene → matches inconsistentes).
 *
 * El folding de tildes es por TABLA explícita (no `String.normalize('NFD')`+strip), para espejar carácter por
 * carácter el `translate()` de Postgres y no introducir diferencias sutiles (ej. ß, ligaduras) entre ambos lados.
 */

/** Pares (acentuado → ascii) que espejan el `translate()` de la columna generada. Orden irrelevante. */
const ACCENT_MAP: Readonly<Record<string, string>> = {
  á: 'a',
  é: 'e',
  í: 'i',
  ó: 'o',
  ú: 'u',
  à: 'a',
  è: 'e',
  ì: 'i',
  ò: 'o',
  ù: 'u',
  ä: 'a',
  ë: 'e',
  ï: 'i',
  ö: 'o',
  ü: 'u',
  â: 'a',
  ê: 'e',
  î: 'i',
  ô: 'o',
  û: 'u',
  ñ: 'n',
  ç: 'c',
  Á: 'A',
  É: 'E',
  Í: 'I',
  Ó: 'O',
  Ú: 'U',
  À: 'A',
  È: 'E',
  Ì: 'I',
  Ò: 'O',
  Ù: 'U',
  Ä: 'A',
  Ë: 'E',
  Ï: 'I',
  Ö: 'O',
  Ü: 'U',
  Â: 'A',
  Ê: 'E',
  Î: 'I',
  Ô: 'O',
  Û: 'U',
  Ñ: 'N',
  Ç: 'C',
};

/**
 * Normaliza make/model al MISMO canon que la columna generada: sin tildes → trim → colapsa espacios → upper.
 * Idempotente. Cadena vacía si la entrada es solo espacios.
 */
export function normalizeModelTerm(input: string): string {
  const folded = input.replace(/[À-ſ]/g, (ch) => ACCENT_MAP[ch] ?? ch);
  return folded.trim().replace(/\s+/g, ' ').toUpperCase();
}
