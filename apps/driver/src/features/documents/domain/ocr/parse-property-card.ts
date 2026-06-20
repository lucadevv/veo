/**
 * Parser PURO de la TARJETA DE PROPIEDAD vehicular peruana. Recibe las líneas OCR y devuelve placa y
 * propietario de los que está razonablemente seguro. Ancla a formato (placa) + palabra clave
 * (propietario); lo que no puede anclar lo OMITE (degradación honesta — nunca inventa).
 *
 * Heurística:
 *  - **Placa**: 3 letras + 3 dígitos, con guion opcional (`ABC-123` o `ABC123`). Es el patrón peruano
 *    de auto. Se prefiere la línea con "Placa", pero el formato es tan distintivo que también vale sin
 *    etiqueta si hay exactamente un match en el documento.
 *  - **Propietario**: el valor junto a "Propietario"/"Titular".
 */

import { canonicalize, collapseWhitespace, lineMatchesAnyKeyword } from './ocr-text';
import type { ParsedPropertyCard } from './parsed-document';

const PLATE_KEYWORDS = ['placa', 'plate'] as const;
const OWNER_KEYWORDS = ['propietario', 'titular', 'owner'] as const;

/**
 * Patrón de placa peruana de auto: 3 letras + 3 dígitos, guion opcional. Normaliza al canónico con
 * guion (`ABC-123`). Devuelve el primer match de la línea o `undefined`.
 */
function plateInLine(line: string): string | undefined {
  const match = /\b([A-Z]{3})-?(\d{3})\b/.exec(line.toUpperCase());
  return match?.[1] && match[2] ? `${match[1]}-${match[2]}` : undefined;
}

/**
 * Extrae la placa. Si una línea menciona "Placa" y trae el patrón → ese (máxima confianza). Si no, junta
 * todos los matches del documento: exactamente uno → ese; varios ambiguos → se OMITE (no se adivina).
 */
function extractPlate(lines: readonly string[]): string | undefined {
  const all = new Set<string>();
  for (const line of lines) {
    const plate = plateInLine(line);
    if (!plate) {
      continue;
    }
    if (lineMatchesAnyKeyword(canonicalize(line), PLATE_KEYWORDS)) {
      return plate;
    }
    all.add(plate);
  }
  return all.size === 1 ? [...all][0] : undefined;
}

/** Toma el valor a la derecha de la etiqueta de propietario (misma línea tras `:`, o línea siguiente). */
function extractOwner(lines: readonly string[]): string | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    if (!lineMatchesAnyKeyword(canonicalize(line), OWNER_KEYWORDS)) {
      continue;
    }
    const afterColon = line.includes(':') ? line.slice(line.indexOf(':') + 1) : '';
    const inline = collapseWhitespace(afterColon);
    if (inline.length > 0) {
      return inline;
    }
    const next = lines[i + 1];
    if (next) {
      const value = collapseWhitespace(next);
      if (value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Parsea las líneas OCR de una tarjeta de propiedad peruana. Devuelve solo lo que extrajo con confianza;
 * texto basura → `{}` (no inventa).
 */
export function parsePropertyCard(lines: readonly string[]): ParsedPropertyCard {
  const result: ParsedPropertyCard = {};
  const plate = extractPlate(lines);
  if (plate) {
    result.plate = plate;
  }
  const owner = extractOwner(lines);
  if (owner) {
    result.owner = owner;
  }
  return result;
}
