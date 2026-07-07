/**
 * Normalización PURA de fechas que aparecen en documentos peruanos al formato canónico `YYYY-MM-DD`.
 * Los documentos peruanos escriben la fecha como DD/MM/YYYY (o con `-`, `.` o espacios) y, en algunos
 * casos, con el MES en letras (`12 ENE 2027`, `12 de enero de 2027`). El OCR puede colar separadores
 * raros, por eso se trabaja sobre el texto crudo con tolerancia, pero SIEMPRE validando que la fecha
 * sea un día real: si no lo es, se devuelve `null` (degradación honesta — nunca una fecha inventada).
 */

import { stripDiacritics } from './ocr-text';

/** Meses en español (incluye abreviaturas de 3 letras), indexados 1..12. Sin acentos para comparar. */
const SPANISH_MONTHS: Readonly<Record<string, number>> = {
  ene: 1,
  enero: 1,
  feb: 2,
  febrero: 2,
  mar: 3,
  marzo: 3,
  abr: 4,
  abril: 4,
  may: 5,
  mayo: 5,
  jun: 6,
  junio: 6,
  jul: 7,
  julio: 7,
  ago: 8,
  agosto: 8,
  sep: 9,
  set: 9,
  setiembre: 9,
  septiembre: 9,
  oct: 10,
  octubre: 10,
  nov: 11,
  noviembre: 11,
  dic: 12,
  diciembre: 12,
};

/** Año plausible para un documento de identidad/vehicular (evita capturar números de 4 dígitos sueltos). */
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

/**
 * ¿`year-month-day` es un día calendario REAL? Construye la fecha en UTC y verifica que no haya
 * "desbordado" (p. ej. 31/02 no existe → JS lo corre a marzo, y la verificación lo detecta).
 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Formatea componentes ya validados al canónico `YYYY-MM-DD` con padding. */
function toIso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Intenta leer una fecha NUMÉRICA `DD<sep>MM<sep>YYYY` del texto (sep = `/`, `-`, `.` o espacios). Si
 * el año viene de 2 dígitos NO se asume el siglo (ambiguo) → se ignora ese formato. Devuelve el ISO o
 * `null`. Es la primera línea de defensa porque es el formato dominante en docs peruanos.
 */
function parseNumericDate(text: string): string | null {
  const match = /\b(\d{1,2})[\s./-](\d{1,2})[\s./-](\d{4})\b/.exec(text);
  if (!match || !match[1] || !match[2] || !match[3]) {
    return null;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  return isRealDate(year, month, day) ? toIso(year, month, day) : null;
}

/**
 * Intenta leer una fecha con el MES en LETRAS: `DD <mes> YYYY` o `DD de <mes> de YYYY` (acepta el `de`
 * intermedio opcional). El mes se busca en el diccionario español sin acentos. Devuelve el ISO o `null`.
 */
function parseTextualDate(text: string): string | null {
  const normalized = stripDiacritics(text).toLowerCase();
  const match = /\b(\d{1,2})\s+(?:de\s+)?([a-z]{3,})\.?\s+(?:de\s+)?(\d{4})\b/.exec(normalized);
  if (!match || !match[1] || !match[2] || !match[3]) {
    return null;
  }
  const day = Number(match[1]);
  const monthName = match[2];
  const year = Number(match[3]);
  const month = SPANISH_MONTHS[monthName];
  if (month === undefined) {
    return null;
  }
  return isRealDate(year, month, day) ? toIso(year, month, day) : null;
}

/**
 * Normaliza la PRIMERA fecha reconocible de un texto al canónico `YYYY-MM-DD`. Prueba el formato
 * numérico (dominante) y, si no, el textual con mes en letras. Si no hay una fecha real, devuelve
 * `null`: el parser que la invoca simplemente OMITE el campo (no inventa un vencimiento/nacimiento).
 */
export function normalizePeruvianDate(text: string): string | null {
  return parseNumericDate(text) ?? parseTextualDate(text);
}
