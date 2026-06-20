/**
 * Parser PURO del SOAT (Seguro Obligatorio de Accidentes de Tránsito) peruano. Recibe las líneas OCR y
 * devuelve número de póliza y vigencia ("Hasta"/"Vence") de los que está razonablemente seguro. Ancla a
 * palabras clave + formato; lo que no puede anclar lo OMITE (degradación honesta — nunca inventa).
 *
 * Soporta DOS formatos del mundo real:
 *  - **CERTIFICADO SOAT estándar** (etiqueta combinada `N° Póliza - Certificado`, bloque `CONTROL
 *    POLICIAL` con `Hasta`).
 *  - **BOLETA de venta electrónica (La Positiva)**, el recibo del SOAT, con etiquetas DISTINTAS:
 *    `POLIZA : <número>` standalone y `FIN VIG. DOC`/`FIN VIG. POL` para el vencimiento.
 *
 * Heurística (GROUND TRUTH, documentos oficiales):
 *  - **Número de póliza**: (a) campo COMBINADO `N° Póliza - Certificado` (variantes `N°`/`Nº`/`No`,
 *    separador ` - ` o ` / `), VALOR `\d{8,10} [-/] \d{1,2}` (ej. `2012044701 - 1`); o (b) etiqueta
 *    `POLIZA`/`Póliza` STANDALONE con valor numérico tras `:` (ej. `143139370`, 8-10 díg). Se ancla
 *    SIEMPRE a la etiqueta. NUNCA captura `N° PROFORMA` ni `COD.CONTRATANTE` (etiquetas distintas).
 *  - **Vencimiento**: del certificado hay DOS bloques "Hasta" → se PREFIERE el `Hasta` del bloque
 *    "CERTIFICADO SOAT" / "CONTROL POLICIAL"; si no, fallback al `Hasta` de "VIGENCIA DE LA PÓLIZA".
 *    De la boleta se reconoce `FIN VIG. DOC` / `FIN VIG. POL` / `FIN VIG` (con/sin puntos/tildes),
 *    prefiriendo `FIN VIG. DOC` sobre `FIN VIG. POL`. En un rango "Desde X Hasta Y" se toma Y (la mayor
 *    de la línea). NUNCA toma `INICIO VIG` ni `VENC. DOC.` (esas son inicio/pago, no fin de cobertura).
 */

import { normalizePeruvianDate } from './ocr-date';
import { canonicalize, collapseWhitespace, lineMatchesAnyKeyword } from './ocr-text';
import type { ParsedSoat } from './parsed-document';

/**
 * Segmento de ETIQUETA de una línea con `:` (lo de la IZQUIERDA, canonicalizado y SIN puntos para
 * tolerar abreviaturas tipo `FIN VIG. DOC.`) junto al VALOR (lo de la derecha, con espacios colapsados).
 * Devuelve `undefined` si la línea no trae `:` o no hay valor. Reusa los helpers de normalización.
 */
function labelAndValue(line: string): { label: string; value: string } | undefined {
  if (!line.includes(':')) {
    return undefined;
  }
  const idx = line.indexOf(':');
  const label = canonicalize(line.slice(0, idx)).replace(/\./g, '').trim();
  const value = collapseWhitespace(line.slice(idx + 1));
  return value.length > 0 ? { label, value } : undefined;
}

const POLICY_KEYWORDS = ['poliza', 'certificado', 'policy'] as const;
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

/**
 * Etiqueta EXACTA del número de póliza standalone (formato BOLETA La Positiva): `POLIZA : 143139370`.
 * Match EXACTO del segmento de etiqueta (antes del `:`, sin puntos) para NO capturar `N° PROFORMA`
 * (`n proforma`) ni `COD.CONTRATANTE` (`codcontratante`), que tienen etiqueta distinta.
 */
const POLICY_STANDALONE_LABELS = ['poliza', 'n poliza', 'no poliza'] as const;
/**
 * Etiquetas de FIN de vigencia (formato BOLETA La Positiva), por PREFIJO de etiqueta. Se PREFIERE
 * `FIN VIG. DOC` (vigencia del documento) sobre `FIN VIG. POL` (vigencia de la póliza). NUNCA matchea
 * `INICIO VIG.` ni `VENC. DOC.` (esas son inicio/pago, no fin de cobertura).
 */
const FIN_VIG_DOC_PREFIXES = ['fin vig doc', 'fin vig dctos', 'fin vig docto'] as const;
const FIN_VIG_POL_PREFIXES = ['fin vig pol', 'fin vig'] as const;
/**
 * GROUND TRUTH: el SOAT tiene DOS bloques con "Hasta". El de "CERTIFICADO SOAT" / "CONTROL POLICIAL" es el
 * que rige el vencimiento operativo → se prioriza su "Hasta" sobre el de "VIGENCIA DE LA PÓLIZA".
 */
const CONTROL_BLOCK_KEYWORDS = ['certificado soat', 'control policial'] as const;

/**
 * Valor del número de póliza combinado (GROUND TRUTH): `\d{8,10}` + separador `-`/`/` + `\d{1,2}`. Se
 * normaliza a la forma con `-` y un solo espacio (`2012044701 - 1`). Busca el patrón en la línea entera
 * (el valor puede estar tras la etiqueta `N° Póliza - Certificado`, que también contiene un `-`).
 */
function policyTokenInLine(line: string): string | undefined {
  const match = /(\d{8,10})\s*[-/]\s*(\d{1,2})/.exec(line);
  return match?.[1] && match[2] ? `${match[1]} - ${match[2]}` : undefined;
}

/**
 * Número de póliza STANDALONE de la BOLETA La Positiva: etiqueta EXACTA `POLIZA` (en `POLICY_STANDALONE_
 * LABELS`) con valor numérico de 8-10 dígitos tras `:` (ej. `143139370`). El match EXACTO de la etiqueta
 * impide capturar `N° PROFORMA` o `COD.CONTRATANTE`. Devuelve solo los dígitos del valor o `undefined`.
 */
function standalonePolicyInLine(line: string): string | undefined {
  const parsed = labelAndValue(line);
  if (!parsed || !POLICY_STANDALONE_LABELS.some((label) => parsed.label === label)) {
    return undefined;
  }
  const match = /\b(\d{8,10})\b/.exec(parsed.value);
  return match?.[1];
}

/** Extrae el número de póliza SOLO de líneas etiquetadas (sin etiqueta no se adivina). */
function extractPolicyNumber(lines: readonly string[]): string | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    // BOLETA La Positiva: etiqueta `POLIZA :` standalone con número numérico (no formato combinado).
    const standalone = standalonePolicyInLine(line);
    if (standalone) {
      return standalone;
    }
    if (!lineMatchesAnyKeyword(canonicalize(line), POLICY_KEYWORDS)) {
      continue;
    }
    // El valor combinado puede estar en la misma línea de la etiqueta o en la de abajo.
    const inline = policyTokenInLine(line);
    if (inline) {
      return inline;
    }
    const next = lines[i + 1];
    if (next) {
      const fromNext = policyTokenInLine(next);
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

/** La fecha de fin de vigencia de una línea de vencimiento es la MAYOR (rango "Desde X Hasta Y" → Y). */
function expiryDateInLine(line: string): string | undefined {
  const canonical = canonicalize(line);
  const isExpiryLine = lineMatchesAnyKeyword(canonical, EXPIRY_KEYWORDS);
  const isStartOnly = lineMatchesAnyKeyword(canonical, START_KEYWORDS) && !isExpiryLine;
  if (isStartOnly || !isExpiryLine) {
    return undefined;
  }
  const dates = datesInLine(line);
  if (dates.length === 0) {
    return undefined;
  }
  return dates.reduce((max, d) => (d > max ? d : max));
}

/**
 * Vencimiento del formato BOLETA La Positiva: etiquetas `FIN VIG. DOC` (preferida) / `FIN VIG. POL` con
 * la fecha tras `:`. Se ancla por PREFIJO del segmento de etiqueta (canonicalizado, sin puntos) para que
 * `fin vig doc` matchee aunque el OCR cuele variantes. NUNCA matchea `inicio vig` ni `venc doc` (no son
 * prefijos `fin vig`). Prefiere `FIN VIG. DOC`; si no existe, cae a `FIN VIG. POL`/`FIN VIG`.
 */
function extractFinVigExpiry(lines: readonly string[]): string | undefined {
  let docExpiry: string | undefined;
  let polExpiry: string | undefined;
  for (const line of lines) {
    const parsed = labelAndValue(line);
    if (!parsed) {
      continue;
    }
    const date = normalizePeruvianDate(parsed.value);
    if (!date) {
      continue;
    }
    if (FIN_VIG_DOC_PREFIXES.some((prefix) => parsed.label.startsWith(prefix))) {
      docExpiry = date;
    } else if (FIN_VIG_POL_PREFIXES.some((prefix) => parsed.label.startsWith(prefix))) {
      polExpiry = date;
    }
  }
  return docExpiry ?? polExpiry;
}

/**
 * Extrae el vencimiento del formato CERTIFICADO estándar (GROUND TRUTH: hay DOS "Hasta"). Recorre las
 * líneas rastreando si estamos DENTRO
 * del bloque "CERTIFICADO SOAT" / "CONTROL POLICIAL" (un encabezado de ese bloque "arma" el flag hasta el
 * próximo encabezado de bloque). Recoge por separado el "Hasta" del bloque de control y el de cualquier
 * otro bloque (vigencia de la póliza). PREFIERE el del bloque de control; si no hay, cae al otro. En cada
 * grupo toma la fecha más tardía (por si el OCR repite/mezcla).
 */
function extractCertificateExpiry(lines: readonly string[]): string | undefined {
  let controlExpiry: string | undefined;
  let fallbackExpiry: string | undefined;
  let inControlBlock = false;

  for (const line of lines) {
    const canonical = canonicalize(line);
    const isControlHeader = lineMatchesAnyKeyword(canonical, CONTROL_BLOCK_KEYWORDS);
    if (isControlHeader) {
      inControlBlock = true;
    }
    const expiry = expiryDateInLine(line);
    if (!expiry) {
      continue;
    }
    if (inControlBlock || isControlHeader) {
      if (!controlExpiry || expiry > controlExpiry) {
        controlExpiry = expiry;
      }
    } else if (!fallbackExpiry || expiry > fallbackExpiry) {
      fallbackExpiry = expiry;
    }
  }
  return controlExpiry ?? fallbackExpiry;
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
  // BOLETA La Positiva (FIN VIG. DOC/POL) primero; si no, formato CERTIFICADO estándar (Hasta del bloque
  // de control). Son formatos mutuamente excluyentes: el certificado no trae `FIN VIG` y la boleta no
  // trae `Hasta`/bloque de control, así que el orden no se pisan entre formatos.
  const expiresAt = extractFinVigExpiry(lines) ?? extractCertificateExpiry(lines);
  if (expiresAt) {
    result.expiresAt = expiresAt;
  }
  return result;
}
