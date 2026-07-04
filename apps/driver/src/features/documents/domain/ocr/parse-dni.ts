/**
 * Parser PURO del DNI peruano (Documento Nacional de Identidad) a partir de las líneas de texto que el
 * OCR on-device reconoce. NO tiene estado ni efectos: recibe las líneas del FRENTE (y opcionalmente del
 * REVERSO) y devuelve los campos de los que está razonablemente seguro. Lo que no puede anclar con
 * confianza, lo OMITE (degradación honesta).
 *
 * Estrategia por confianza decreciente (cubre DNIe 3.0, Modelo 2020 y VIEJO/azul):
 *  - **Plan A — MRZ (DNIe + viejo azul):** si el OCR trae un MRZ TD1 (3 líneas estandarizadas ICAO 9303),
 *    se parsea ahí (`parseMrzTd1`). Es mucho más estable que las etiquetas del frente. El MRZ vive en el
 *    REVERSO del DNIe y en el ANVERSO del viejo azul, así que se busca en AMBAS caras. Lo que el MRZ no
 *    resuelva se completa con las etiquetas (merge no destructivo).
 *  - **Plan B — etiquetas del frente (GROUND TRUTH, confirmado por imágenes oficiales):**
 *      - **DNIe 3.0 (2025):** `Apellidos` (UN campo COMBINADO) + `Prenombres`.
 *      - **Modelo 2020 + viejo azul:** `Primer Apellido` + `Segundo Apellido` + `Prenombres` (viejo:
 *        `Pre Nombres`, dos palabras).
 *    OJO: "Apellido Paterno"/"Apellido Materno" NO EXISTEN impresos en ningún DNI → no se buscan.
 *    El VALOR va en la LÍNEA DE ABAJO de la etiqueta (no al lado), salvo `Sexo`/`CUI`/`Nacionalidad`.
 *    El DNI doméstico NO es bilingüe (solo español).
 *
 * Heurística del frente (anclada a formato + palabras clave, no a posición fija, que el OCR no garantiza):
 *  - **Número**: 8 dígitos (DNI) o CUI = 8 dígitos + `-` + 1 verificador (ej. `41326541-5`). Se toman los
 *    8 PRIMEROS dígitos (se descarta el verificador). Se prioriza el que está en/junto a la etiqueta
 *    "DNI"; si no hay etiqueta, se toma el ÚNICO candidato del documento. Varios ambiguos → se OMITE.
 *  - **Fecha de nacimiento**: la fecha en/junto a la línea con "Nacimiento"/"FECHA DE NACIMIENTO".
 *  - **Nombre**: combinado (`Apellidos`) o separado (`Primer/Segundo Apellido`) + prenombres.
 */

import { normalizePeruvianDate } from './ocr-date';
import { parseMrzTd1 } from './parse-mrz-td1';
import { canonicalize, collapseWhitespace, lineMatchesAnyKeyword } from './ocr-text';
import type { ParsedDni } from './parsed-document';

/** Palabras clave (canonicalizadas) que anclan el número de DNI/CUI. */
const DNI_NUMBER_KEYWORDS = ['dni', 'documento nacional', 'cui'] as const;
/** Palabras clave que anclan la fecha de nacimiento. */
const BIRTH_KEYWORDS = ['nacimiento', 'fecha de nacimiento', 'birth'] as const;
/**
 * Palabras clave de las OTRAS fechas del DNIe (emisión/caducidad). Una fecha en/junto a una de estas NO
 * es el nacimiento — sirve para no confundir la fecha de emisión (2025) ni la de caducidad (2033) con la
 * de nacimiento cuando se cae al fallback por patrón.
 */
const NON_BIRTH_DATE_KEYWORDS = ['emision', 'expedicion', 'caducidad', 'vencimiento', 'expiry'] as const;
/**
 * Etiqueta del PRIMER apellido (Modelo 2020 / viejo azul). GROUND TRUTH: NO existe "Apellido Paterno"
 * impreso — el rótulo real es "Primer Apellido".
 */
const FIRST_SURNAME_KEYWORDS = ['primer apellido'] as const;
/** Etiqueta del SEGUNDO apellido (Modelo 2020 / viejo azul). Rótulo real: "Segundo Apellido". */
const SECOND_SURNAME_KEYWORDS = ['segundo apellido'] as const;
/** Etiqueta de los prenombres (DNIe 3.0/Modelo 2020: "Prenombres"; viejo azul: "Pre Nombres", 2 palabras). */
const GIVEN_NAME_KEYWORDS = ['pre nombres', 'prenombres'] as const;
/** Etiqueta del DNIe 3.0 que junta ambos apellidos en UN campo combinado ("Apellidos"). */
const COMBINED_SURNAME_KEYWORDS = ['apellidos'] as const;

/**
 * Todas las apariciones de "8 dígitos (+ opcional separador `-`/espacio + 1 verificador)" en una línea.
 * Devuelve solo los 8 PRIMEROS dígitos de cada match (descarta el dígito verificador). El lookaround
 * evita capturar tramos de 9+ dígitos pegados (que no son el formato del DNI).
 */
function dniNumberMatches(line: string): string[] {
  const matches = line.match(/(?<!\d)\d{8}(?:[-\s]?\d)?(?!\d)/g) ?? [];
  return matches.map((m) => m.replace(/\D+/g, '').slice(0, 8));
}

/**
 * Extrae el número de DNI (8 dígitos, sin verificador). Estrategia por confianza decreciente:
 *  1. Una línea con "DNI"/"Documento nacional" que contiene el número → ese (máxima confianza).
 *  2. La etiqueta "DNI" en una línea SIN número → se mira la línea SIGUIENTE (como hace la fecha).
 *  3. Si en TODO el documento hay exactamente UN candidato → ese (sin ambigüedad).
 *  4. Varios candidatos sin etiqueta → se OMITE (no se adivina cuál es el DNI).
 */
function extractDocumentNumber(lines: readonly string[]): string | undefined {
  const allCandidates: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const matches = dniNumberMatches(line);
    const isLabelLine = lineMatchesAnyKeyword(canonicalize(line), DNI_NUMBER_KEYWORDS);
    if (isLabelLine && matches[0]) {
      return matches[0];
    }
    if (isLabelLine && matches.length === 0) {
      // Etiqueta "DNI" sola: el número quedó en la línea de abajo.
      const next = lines[i + 1];
      const nextMatch = next ? dniNumberMatches(next)[0] : undefined;
      if (nextMatch) {
        return nextMatch;
      }
    }
    allCandidates.push(...matches);
  }
  return allCandidates.length === 1 ? allCandidates[0] : undefined;
}

/**
 * Extrae la fecha de nacimiento. Estrategia por confianza decreciente, porque el OCR DISPERSA la etiqueta
 * ("Fecha de Nacimiento", a veces dentro de una línea combinada "Nacionalidad Fecha de Nacimiento") LEJOS
 * de su valor `07 12 1998`:
 *  1. La etiqueta de nacimiento en la MISMA línea que la fecha → esa (máxima confianza).
 *  2. La etiqueta de nacimiento con la fecha en la línea SIGUIENTE → esa.
 *  3. FALLBACK por PATRÓN: junta todas las fechas del doc que NO estén en líneas de emisión/caducidad y
 *     toma la MÁS ANTIGUA (el nacimiento siempre precede a emisión/caducidad). Así, si hay emisión 2025 y
 *     caducidad 2033, el nacimiento 1998 gana por ser el más antiguo, sin necesitar la etiqueta adyacente.
 */
function extractBirthDate(lines: readonly string[]): string | undefined {
  const candidates: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const canonical = canonicalize(line);
    if (lineMatchesAnyKeyword(canonical, BIRTH_KEYWORDS)) {
      const sameLine = normalizePeruvianDate(line);
      if (sameLine) {
        return sameLine;
      }
      const next = lines[i + 1];
      const nextLine = next ? normalizePeruvianDate(next) : null;
      if (nextLine) {
        return nextLine;
      }
    }
    // Para el fallback: ignoramos fechas que están en una línea de emisión/caducidad (no son nacimiento).
    if (lineMatchesAnyKeyword(canonical, NON_BIRTH_DATE_KEYWORDS)) {
      continue;
    }
    const date = normalizePeruvianDate(line);
    if (date) {
      candidates.push(date);
    }
  }
  if (candidates.length === 0) {
    return undefined;
  }
  // ISO `YYYY-MM-DD` ordena lexicográficamente = cronológicamente; la más antigua es el nacimiento.
  return [...candidates].sort()[0];
}

/**
 * Toma el valor a la derecha de una etiqueta. Orden de preferencia:
 *  1. Tras un `:` en la misma línea (`Apellidos: QUISPE`).
 *  2. Tras el RÓTULO mismo en la misma línea (`Apellido Paterno LÓPEZ` → `LÓPEZ`), recortando el texto
 *     del keyword que matcheó (el layout del DNIe imprime label y valor juntos sin `:`).
 *  3. En la línea de ABAJO si en esta solo estaba el rótulo.
 * Devuelve `undefined` si ninguna fuente trae texto útil.
 */
function valueForLabel(
  lines: readonly string[],
  index: number,
  keywords: readonly string[],
): string | undefined {
  const line = lines[index];
  if (line === undefined) {
    return undefined;
  }
  const canonical = canonicalize(line);
  const matched = keywords.find((k) => k.length > 0 && canonical.includes(k));
  if (matched === undefined) {
    return undefined;
  }

  // (1) Valor tras `:`.
  if (line.includes(':')) {
    const inline = collapseWhitespace(line.slice(line.indexOf(':') + 1));
    if (inline.length > 0) {
      return inline;
    }
  } else {
    // (2) Valor tras el rótulo en la misma línea: recorta tantas palabras como tiene el keyword matcheado.
    const labelWordCount = matched.split(' ').length;
    const words = collapseWhitespace(line).split(' ');
    const afterLabel = collapseWhitespace(words.slice(labelWordCount).join(' '));
    if (afterLabel.length > 0) {
      return afterLabel;
    }
  }

  // (3) Valor en la línea de abajo (rótulo solo).
  const next = lines[index + 1];
  return next ? collapseWhitespace(next) || undefined : undefined;
}

/**
 * Captura el valor del PRIMER rótulo que matchee, probando los grupos de keywords en ORDEN (los más
 * específicos primero). Devuelve el valor del label o `undefined` si ninguno ancló en este índice.
 */
function valueForFirstMatchingLabel(
  lines: readonly string[],
  index: number,
  keywordGroups: readonly (readonly string[])[],
): string | undefined {
  for (const keywords of keywordGroups) {
    const value = valueForLabel(lines, index, keywords);
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Compone el nombre completo del DNI peruano. GROUND TRUTH (imágenes oficiales): hay DOS layouts de
 * apellidos que el parser debe soportar simultáneamente:
 *  - **Separado** (Modelo 2020 / viejo azul): `Primer Apellido` + `Segundo Apellido` (rótulos reales).
 *  - **Combinado** (DNIe 3.0): un solo campo `Apellidos`.
 * En ambos, el VALOR vive en la LÍNEA DE ABAJO del rótulo. Los prenombres salen de `Prenombres`/`Pre
 * Nombres`. El orden importa: los rótulos específicos (`primer/segundo apellido`) se evalúan ANTES que el
 * genérico `apellidos`, y el combinado solo se usa si NO se ancló ningún apellido separado en el doc (para
 * que "Primer Apellido" no caiga por error en el bucket combinado vía substring). Nombre final =
 * `[apellidos, prenombres].filter(Boolean).join(' ')`. Si nada ancla → `undefined`.
 */
function extractFullName(lines: readonly string[]): string | undefined {
  let firstSurname: string | undefined;
  let secondSurname: string | undefined;
  let given: string | undefined;
  let combinedSurnames: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    // Orden importa: rótulos separados (específicos) antes que el genérico "apellidos" (DNIe 3.0).
    firstSurname ??= valueForLabel(lines, i, FIRST_SURNAME_KEYWORDS);
    secondSurname ??= valueForLabel(lines, i, SECOND_SURNAME_KEYWORDS);
    given ??= valueForLabel(lines, i, GIVEN_NAME_KEYWORDS);
    if (!firstSurname && !secondSurname) {
      // Solo consideramos "Apellidos" combinado si aún no anclamos un apellido separado en este doc.
      combinedSurnames ??= valueForFirstMatchingLabel(lines, i, [COMBINED_SURNAME_KEYWORDS]);
    }
  }

  // Apellidos: los 2 campos separados (Modelo 2020/viejo) o el bloque combinado (DNIe 3.0) como fallback.
  const separated = [firstSurname, secondSurname].filter((p): p is string => !!p && p.length > 0);
  const surnames = separated.length > 0 ? separated.join(' ') : combinedSurnames;

  const parts = [surnames, given].filter((part): part is string => !!part && part.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  return collapseWhitespace(parts.join(' '));
}

/** Parsea SOLO las etiquetas del frente del DNI (plan B / DNI viejo). */
function parseFront(lines: readonly string[]): ParsedDni {
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

/**
 * Parsea el DNI peruano. PRIMERO intenta el MRZ TD1 (plan A): si trae algo con confianza (al menos número
 * o nombre), se usa y se MERGEA lo que falte con el parseo de etiquetas. Si no hay MRZ válido, cae al
 * parseo de etiquetas del frente (plan B). GROUND TRUTH: el MRZ vive en el REVERSO del DNIe PERO en el
 * ANVERSO del viejo azul → se busca PRIMERO en el reverso (DNIe, más común) y, si no aparece, en el frente
 * (viejo azul). Devuelve SOLO los campos extraídos con confianza; los ausentes quedan para tipeo manual.
 * Texto basura → `{}` (no inventa).
 *
 * @param frontLines Líneas OCR del ANVERSO (donde vive el MRZ del viejo azul).
 * @param backLines  Líneas OCR del REVERSO (donde vive el MRZ del DNIe). Opcional.
 */
export function parseDni(
  frontLines: readonly string[],
  backLines?: readonly string[],
): ParsedDni {
  const front = parseFront(frontLines);

  // MRZ-first: reverso (DNIe) primero; si no hay, frente (viejo azul tiene el MRZ en el anverso).
  const mrz = parseMrzTd1(backLines) ?? parseMrzTd1(frontLines);
  // El MRZ es plan A solo si extrajo algo con confianza (número o nombre). El nacimiento solo no basta
  // para preferirlo (un YYMMDD aislado es débil), pero igual se mergea si el frente no lo trae.
  if (mrz && (mrz.documentNumber || mrz.fullName)) {
    return {
      ...front,
      // NÚMERO y NACIMIENTO: el MRZ gana (dígitos estructurados, más estables que el OCR de las etiquetas).
      ...(mrz.documentNumber ? { documentNumber: mrz.documentNumber } : {}),
      ...(mrz.birthDate ? { birthDate: mrz.birthDate } : {}),
      // NOMBRE: gana el FRENTE (rótulos explícitos "Primer Apellido"/"Segundo Apellido"/"Prenombres"). El
      // MRZ NO es confiable para el nombre: el OCR mutila los separadores `<` de la L3 y se COME apellidos
      // (visto en campo: `CARRANZA<<LUIS<IVAN` en vez de `CARRANZA<SALDANA<<LUIS<IVAN` → dropea "SALDAÑA").
      // Solo caemos al nombre del MRZ si el frente NO leyó ninguno (DNI viejo/etiqueta ilegible).
      ...(!front.fullName && mrz.fullName ? { fullName: mrz.fullName } : {}),
    };
  }

  // Sin MRZ con confianza: frente como fuente, pero rescatamos un nacimiento del MRZ si el frente no lo dio.
  if (mrz?.birthDate && !front.birthDate) {
    return { ...front, birthDate: mrz.birthDate };
  }
  return front;
}
