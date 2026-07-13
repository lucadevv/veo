/**
 * Formateadores puros y deterministas (sin dependencias de Intl/locale-data, para no romper en
 * Hermes ni en Jest). Dinero en céntimos PEN (entero), distancias en metros, duración en segundos.
 */

/** Formato peruano de céntimos PEN a soles: 1500 → "S/ 15.00". */
export function formatPEN(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const soles = Math.floor(abs / 100);
  const remainder = abs % 100;
  // Separador de miles manual (es-PE usa coma).
  const grouped = soles.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}S/ ${grouped}.${remainder.toString().padStart(2, '0')}`;
}

/** Entero con separador de miles (es-PE usa coma): 1890 → "1,890". Sin Intl (Hermes-safe). */
export function formatInt(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Distancia en metros a texto legible: 850 → "850 m", 4200 → "4.2 km". */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Duración en segundos a minutos redondeados: 540 → "9 min". Mínimo "1 min". */
export function formatDurationMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** Fecha ISO a fecha corta es-PE sin Intl: "2026-05-29T..." → "29/05/2026". */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

/** Fecha ISO a fecha + hora corta: "29/05/2026 15:04". */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${formatShortDate(iso)} ${hours}:${minutes}`;
}

/**
 * Enmascara un documento de identidad dejando visibles los últimos 4 caracteres: "12345678" → "••••5678".
 * Para mostrar el documento en el perfil sin exponerlo entero (privacidad). Documentos cortos (≤4) se
 * muestran tal cual. Devuelve "" si no hay documento.
 */
export function maskDocument(document: string | null | undefined): string {
  const value = (document ?? '').trim();
  if (value.length === 0) {
    return '';
  }
  if (value.length <= 4) {
    return value;
  }
  const visible = value.slice(-4);
  return `${'•'.repeat(value.length - 4)}${visible}`;
}

/** Hora local "HH:mm" de una fecha ISO sin Intl: "2026-05-29T15:04…" → "15:04". */
export function formatTimeOfDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Días de calendario transcurridos entre `iso` y `now` (ambos a medianoche local). 0 = hoy, 1 = ayer.
 * Compara DÍAS, no 24h: un viaje de las 23:00 de ayer es "ayer" aunque hayan pasado <24h. Devuelve
 * `null` si la fecha es inválida.
 */
export function calendarDaysAgo(
  iso: string,
  now: Date = new Date(),
): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const startOf = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((startOf(now) - startOf(date)) / dayMs);
}

/** Hora local de un epoch (ms) a "HH:mm" sin Intl: 15:04. */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}
