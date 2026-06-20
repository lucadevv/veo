/**
 * Parser PURO del SOAT (Seguro Obligatorio de Accidentes de Tránsito) peruano. Recibe las líneas OCR y
 * devuelve número de póliza y vigencia ("Hasta"/"Vence") de los que está razonablemente seguro. Ancla a
 * palabras clave + formato; lo que no puede anclar lo OMITE (degradación honesta — nunca inventa).
 *
 * Heurística:
 *  - **Número de póliza**: el token alfanumérico junto a "Póliza"/"N° de Póliza"/"Certificado". Es un
 *    código de aseguradora (formato variable), así que se ancla SIEMPRE a la etiqueta (sin etiqueta no
 *    se adivina, para no confundirlo con la placa o un código de barras).
 *  - **Vencimiento**: la fecha de la línea de fin de vigencia ("Hasta"/"Vence"/"Vigencia ... Hasta"). Se
 *    prefiere la fecha MÁS TARDÍA de una línea con dos fechas (rango "Desde DD/MM/AAAA Hasta DD/MM/AAAA").
 */

import { normalizePeruvianDate } from './ocr-date';
import { canonicalize, collapseWhitespace, lineMatchesAnyKeyword } from './ocr-text';
import type { ParsedSoat } from './parsed-document';

const POLICY_KEYWORDS = ['poliza', 'n° de poliza', 'nro poliza', 'certificado', 'policy'] as const;
const EXPIRY_KEYWORDS = [
  'hasta',
  'vence',
  'vencimiento',
  'fin de vigencia',
  'termino',
  'valido hasta',
] as const;
/** Línea que delata la fecha de INICIO de vigencia (se usa para preferir la fecha de fin si hay rango). */
const START_KEYWORDS = ['desde', 'inicio de vigencia'] as const;

/** Token de póliza: bloque alfanumérico (con `-`/`/`) de al menos 5 caracteres tras la etiqueta. */
function policyTokenAfterLabel(line: string): string | undefined {
  const afterColon = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
  const match = /([A-Za-z0-9][A-Za-z0-9\-/]{4,})/.exec(collapseWhitespace(afterColon));
  return match?.[1];
}

/** Extrae el número de póliza SOLO de líneas etiquetadas (sin etiqueta no se adivina). */
function extractPolicyNumber(lines: readonly string[]): string | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    if (!lineMatchesAnyKeyword(canonicalize(line), POLICY_KEYWORDS)) {
      continue;
    }
    // Evita capturar la palabra clave misma: busca el token en lo que sigue al `:` o etiqueta.
    const inline = policyTokenAfterLabel(line);
    if (inline && canonicalize(inline) !== 'poliza') {
      return inline;
    }
    const next = lines[i + 1];
    if (next) {
      const fromNext = policyTokenAfterLabel(next);
      if (fromNext) {
        return fromNext;
      }
    }
  }
  return undefined;
}

/** Todas las fechas normalizables de una línea (para resolver rangos "Desde … Hasta …"). */
function datesInLine(line: string): string[] {
  const dates: string[] = [];
  // Captura fechas numéricas DD/MM/AAAA repetidas en la misma línea.
  const matches = line.match(/\b\d{1,2}[\s./-]\d{1,2}[\s./-]\d{4}\b/g) ?? [];
  for (const raw of matches) {
    const iso = normalizePeruvianDate(raw);
    if (iso) {
      dates.push(iso);
    }
  }
  return dates;
}

/**
 * Extrae el vencimiento. Si una línea de vigencia trae DOS fechas (rango), toma la MÁS TARDÍA (el fin);
 * si trae una sola en una línea "Hasta/Vence", la usa. Ignora las líneas marcadas solo como "Desde".
 */
function extractExpiry(lines: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const line of lines) {
    const canonical = canonicalize(line);
    const isExpiryLine = lineMatchesAnyKeyword(canonical, EXPIRY_KEYWORDS);
    const isStartOnly =
      lineMatchesAnyKeyword(canonical, START_KEYWORDS) && !isExpiryLine;
    if (isStartOnly || !isExpiryLine) {
      continue;
    }
    const dates = datesInLine(line);
    if (dates.length === 0) {
      continue;
    }
    // La fecha de fin de vigencia es la mayor de la línea (rango "Desde X Hasta Y" → Y).
    const latest = dates.reduce((max, d) => (d > max ? d : max));
    if (!best || latest > best) {
      best = latest;
    }
  }
  return best;
}

/**
 * Parsea las líneas OCR de un SOAT peruano. Devuelve solo lo que extrajo con confianza; texto basura →
 * `{}` (no inventa).
 */
export function parseSoat(lines: readonly string[]): ParsedSoat {
  const result: ParsedSoat = {};
  const policyNumber = extractPolicyNumber(lines);
  if (policyNumber) {
    result.policyNumber = policyNumber;
  }
  const expiresAt = extractExpiry(lines);
  if (expiresAt) {
    result.expiresAt = expiresAt;
  }
  return result;
}
