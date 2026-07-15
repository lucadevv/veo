/**
 * Parser PURO del MRZ TD1 (Machine Readable Zone de 3 líneas) del REVERSO del DNI electrónico peruano
 * (DNIe). Es el "plan A" del parseo del DNI moderno: el MRZ es texto estandarizado por ICAO 9303, mucho
 * más estable para el OCR que las etiquetas del frente (que el OCR confunde por tipografía/fondo).
 *
 * Formato TD1 (3 líneas × 30 caracteres del alfabeto `[A-Z0-9<]`, donde `<` es el relleno):
 *  - L1: `I` + `<PER` + `documentNumber(9)` + … . El número del documento ocupa las posiciones 5..13
 *        (índices 0-based), 9 caracteres rellenados con `<`. En el DNI peruano son los 8 dígitos + el
 *        dígito verificador o relleno; tomamos solo los dígitos.
 *  - L2: `birth(YYMMDD)` + `check` + `sex` + `expiry(YYMMDD)` + … . Nacimiento en 0..5, sexo en 7,
 *        vencimiento en 8..13.
 *  - L3: `APELLIDOS<<PRENOMBRES` con `<` como separador de palabras y `<<` separando apellidos de nombres.
 *
 * Degradación HONESTA: si no se detectan 3 líneas MRZ válidas → `null`. Cada campo que no parsea limpio
 * se OMITE (nunca se inventa). Las fechas se arman por CONCATENACIÓN de strings `YYYY-MM-DD` (sin
 * `new Date`, sin huso horario) para que el día calendario sea EXACTO.
 */

import { stripDiacritics } from './ocr-text';

/** Longitud canónica de cada línea MRZ TD1. */
const TD1_LINE_LENGTH = 30;
/** Alfabeto MRZ: mayúsculas A-Z, dígitos y el relleno `<`. */
const MRZ_ALPHABET = /^[A-Z0-9<]+$/;
/** Captura solo los caracteres del alfabeto MRZ (descarta espacios/ruido que el OCR cuela). */
const MRZ_NON_ALPHABET = /[^A-Z0-9<]/g;

/** Resultado del parseo del MRZ TD1. Todos los campos son opcionales (degradación honesta). */
export interface ParsedMrzTd1 {
  /** Número de documento (solo dígitos, sin relleno `<` ni verificador no-numérico). */
  documentNumber?: string;
  /** Nombre completo `APELLIDOS PRENOMBRES` reconstruido desde la línea de nombre. */
  fullName?: string;
  /** Fecha de nacimiento en `YYYY-MM-DD`. */
  birthDate?: string;
}

/**
 * Normaliza una línea cruda del OCR a la forma MRZ: mayúsculas, sin diacríticos y SIN caracteres fuera
 * del alfabeto `[A-Z0-9<]` (el OCR cuela espacios, comas, etc.). El OCR a veces parte una línea MRZ en
 * varias; por eso el detector trabaja sobre líneas YA normalizadas y filtra por longitud.
 */
function normalizeMrzLine(line: string): string {
  return stripDiacritics(line).toUpperCase().replace(MRZ_NON_ALPHABET, '');
}

/**
 * ¿La línea normalizada es una línea MRZ TD1 plausible? Debe tener exactamente 30 caracteres del
 * alfabeto MRZ y contener al menos un relleno `<` (las 3 líneas TD1 siempre lo llevan: número/fechas
 * rellenadas o separadores de nombre). El `<` evita confundir un bloque de 30 dígitos sueltos con MRZ.
 */
function isMrzLine(normalized: string): boolean {
  return (
    normalized.length === TD1_LINE_LENGTH &&
    MRZ_ALPHABET.test(normalized) &&
    normalized.includes('<')
  );
}

/** Cota superior al re-unir fragmentos de una línea MRZ partida por el OCR: nunca pasarse de 30 chars. */
const TD1_MAX_FRAGMENTS_JOIN = 30;

/**
 * Detecta las 3 líneas MRZ TD1 entre las líneas OCR. Estrategia ENDURECIDA en dos pasadas:
 *  1. **Directa:** 3 líneas consecutivas que ya son MRZ válidas (30 chars del alfabeto, con `<`).
 *  2. **Re-unión:** el OCR a veces PARTE una línea MRZ de 30 chars en 2+ fragmentos. Como fallback, se
 *     concatenan los fragmentos normalizados (que solo tienen caracteres del alfabeto MRZ) y, si el stream
 *     resultante contiene tres tramos de 30 chars consecutivos válidos, se reconstruyen las 3 líneas.
 * Si ninguna pasada arma 3 líneas → `null` (no se fuerza un MRZ que no está).
 */
function detectTd1Lines(lines: readonly string[]): [string, string, string] | null {
  const direct = detectDirect(lines);
  if (direct) {
    return direct;
  }
  return detectByRejoin(lines);
}

/** Pasada 1: 3 líneas consecutivas que ya cumplen el formato MRZ (sin re-unir). */
function detectDirect(lines: readonly string[]): [string, string, string] | null {
  const mrz: string[] = [];
  for (const raw of lines) {
    const normalized = normalizeMrzLine(raw);
    if (isMrzLine(normalized)) {
      mrz.push(normalized);
      if (mrz.length === 3) {
        break;
      }
    } else if (mrz.length > 0) {
      // Las 3 líneas MRZ van juntas; una línea no-MRZ tras empezar rompe el bloque (descarta ruido).
      mrz.length = 0;
    }
  }
  if (mrz[0] && mrz[1] && mrz[2]) {
    return [mrz[0], mrz[1], mrz[2]];
  }
  return null;
}

/**
 * Pasada 2 (fallback): el OCR partió las líneas MRZ. Concatena los fragmentos que SOLO tienen caracteres
 * del alfabeto MRZ (descarta el resto) y busca un bloque de 90 chars (3 × 30) que contenga al menos un
 * relleno `<` y que, partido en 3 tramos de 30, dé tres líneas MRZ plausibles. Conservador: solo dispara
 * si los fragmentos limpios suman EXACTAMENTE las 3 líneas (no concatena ruido arbitrario del documento).
 */
function detectByRejoin(lines: readonly string[]): [string, string, string] | null {
  // Los fragmentos solo necesitan ser del alfabeto MRZ (`<` se valida sobre las líneas reconstruidas): el
  // OCR puede partir una línea justo donde no hay relleno (ej. el campo numérico de la L2 sin `<`).
  const fragments = lines
    .map(normalizeMrzLine)
    .filter((f) => f.length > 0 && f.length <= TD1_MAX_FRAGMENTS_JOIN && MRZ_ALPHABET.test(f));
  const joined = fragments.join('');
  if (joined.length !== TD1_LINE_LENGTH * 3) {
    return null;
  }
  const l1 = joined.slice(0, TD1_LINE_LENGTH);
  const l2 = joined.slice(TD1_LINE_LENGTH, TD1_LINE_LENGTH * 2);
  const l3 = joined.slice(TD1_LINE_LENGTH * 2);
  if (isMrzLine(l1) && isMrzLine(l2) && isMrzLine(l3)) {
    return [l1, l2, l3];
  }
  return null;
}

/** Año actual en 2 dígitos: pivote del siglo para fechas de nacimiento YYMMDD del MRZ. */
function currentYearTwoDigits(now: Date): number {
  return now.getFullYear() % 100;
}

/**
 * Convierte un `YYMMDD` del MRZ a `YYYY-MM-DD` por CONCATENACIÓN de strings (sin `new Date`, sin huso).
 * El siglo se resuelve con un pivote: para una fecha de NACIMIENTO, un `YY` mayor al año actual de 2
 * dígitos no puede ser de este siglo (sería futuro) → es `19YY`; en caso contrario, `20YY`. Valida que
 * mes/día estén en rango calendario básico; si no, devuelve `undefined` (degradación honesta).
 */
function birthYymmddToIso(yymmdd: string, now: Date): string | undefined {
  if (!/^\d{6}$/.test(yymmdd)) {
    return undefined;
  }
  const yy = yymmdd.slice(0, 2);
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  const century = Number(yy) > currentYearTwoDigits(now) ? '19' : '20';
  return `${century}${yy}-${mm}-${dd}`;
}

/**
 * Reconstruye el nombre completo desde la línea L3 del MRZ: `APELLIDOS<<PRENOMBRES`. Separa apellidos de
 * nombres por el primer `<<`, reemplaza el resto de `<` por espacios y compone `apellidos prenombres`.
 * Si la línea no trae texto útil (todo relleno) → `undefined`.
 */
function nameFromMrzLine(line: string): string | undefined {
  const [surnamesRaw = '', givenRaw = ''] = line.split('<<');
  const surnames = surnamesRaw.replace(/</g, ' ').trim();
  const given = givenRaw.replace(/</g, ' ').trim();
  const full = [surnames, given]
    .filter((part) => part.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return full.length > 0 ? full : undefined;
}

/** Largo del número de DNI peruano (sin el dígito verificador que el MRZ pone como 9.º char del campo). */
const DNI_DIGITS = 8;

/**
 * Extrae el número de documento de L1: posiciones 5..13 (9 chars). Quita el relleno `<`, deja solo los
 * dígitos y se queda con los 8 PRIMEROS (el DNI peruano son 8 dígitos; el 9.º char del campo MRZ es el
 * verificador, que se descarta aunque sea numérico). Si no quedan dígitos → `undefined`.
 */
function documentNumberFromMrz(line1: string): string | undefined {
  const field = line1.slice(5, 14).replace(/</g, '');
  const digits = field.replace(/\D+/g, '').slice(0, DNI_DIGITS);
  return digits.length > 0 ? digits : undefined;
}

/**
 * Parsea las 3 líneas MRZ TD1 del reverso del DNIe. Devuelve los campos que pudo anclar con confianza, o
 * `null` si las líneas no forman un MRZ TD1 válido (el `parseDni` cae entonces al parseo del frente).
 *
 * @param lines Líneas OCR del REVERSO (pueden venir con ruido; se normalizan internamente).
 * @param now   Fecha de referencia para el pivote de siglo del nacimiento (inyectable para tests).
 */
export function parseMrzTd1(
  lines: readonly string[] | undefined,
  now: Date = new Date(),
): ParsedMrzTd1 | null {
  if (!lines || lines.length === 0) {
    return null;
  }
  const td1 = detectTd1Lines(lines);
  if (!td1) {
    return null;
  }
  const [line1, line2, line3] = td1;

  const result: ParsedMrzTd1 = {};

  const documentNumber = documentNumberFromMrz(line1);
  if (documentNumber) {
    result.documentNumber = documentNumber;
  }

  const birthDate = birthYymmddToIso(line2.slice(0, 6), now);
  if (birthDate) {
    result.birthDate = birthDate;
  }

  const fullName = nameFromMrzLine(line3);
  if (fullName) {
    result.fullName = fullName;
  }

  return result;
}
