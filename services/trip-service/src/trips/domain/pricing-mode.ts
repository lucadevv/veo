/**
 * ModeResolver (ADR 011 §1.1) — decisión PURA de modo de pricing por { zona, hora, schedule }.
 *
 * NO es Strategy (ADR 011 §1.1): es un resolver que devuelve un enum de 2 vías por data; el `if/else`
 * que YA existe en createTrip lo consume. Toda la lógica acá es PURA y unit-testeable (sin DB, sin Nest):
 * el servicio que carga el schedule (PricingScheduleService) inyecta el snapshot y delega en `resolveMode`.
 *
 * HORA LOCAL DE LIMA (ADR 011 §3 + §8.3): las reglas se expresan en hora local de Lima. Perú usa
 * America/Lima = **UTC-5 FIJO, SIN horario de verano (DST)** desde 1994 — el experimento de DST de 1990
 * no volvió. Por eso NO se necesita una librería de zonas horarias: basta desplazar el UTC -5h (-300 min).
 * Si en el futuro Perú reintroduce DST, este es el único punto a cambiar (un offset → una tz lib).
 */
import { PricingMode } from '@veo/shared-types';

/** Offset fijo de Lima respecto a UTC, en minutos. America/Lima = UTC-5 sin DST (Perú, desde 1994). */
export const LIMA_UTC_OFFSET_MINUTES = -300;

/** Minutos en un día (para el wrap del minuto-del-día tras aplicar el offset de Lima). */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Una regla horaria del schedule (Tier 1 GLOBAL). Espeja el payload de pricing.mode_schedule_updated.
 * - `dayMask`: bitmask de días Lun=1, Mar=2, Mié=4, Jue=8, Vie=16, Sáb=32, Dom=64 (1..127).
 * - `startMinute`/`endMinute`: minuto del día (0..1439) en hora LOCAL de Lima. Rango SAME-DAY semiabierto
 *   [start, end): `startMinute <= nowMinute < endMinute`. Si `endMinute <= startMinute` la regla NO matchea
 *   (los rangos overnight NO están soportados en el MVP — modelarlos = follow-up no-breaking).
 * - `mode`: el modo que FUERZA esta regla.
 */
export interface PricingModeRule {
  dayMask: number;
  startMinute: number;
  endMinute: number;
  mode: PricingMode;
}

/** Snapshot del schedule resuelto: defaultMode + reglas en orden de evaluación. */
export interface PricingModeSchedule {
  defaultMode: PricingMode;
  rules: PricingModeRule[];
}

/** Clave de zona (ADR 011 §2). MVP: SIEMPRE 'GLOBAL' (Tier 1). Tier 2 (per-zona) = no-breaking. */
export type ZoneKey = 'GLOBAL';

/**
 * Schedule por defecto cuando no hay fila cargada (instalación nueva / degradación honesta), sin reglas.
 * B5 · postura de producto INVERTIDA respecto del MVP original (ADR 011): el default del sistema es FIXED
 * (precio fijo) — la PUJA es la EXCEPCIÓN programada por horario en el panel admin, no al revés. Ver ADR 011.
 */
export const DEFAULT_SCHEDULE: PricingModeSchedule = { defaultMode: PricingMode.FIXED, rules: [] };

/**
 * Componentes de tiempo en hora LOCAL de Lima derivados de un `Date` (UTC absoluto).
 * - `weekday`: 1=Lun … 7=Dom (ISO-8601), para casar contra el `dayMask`.
 * - `minuteOfDay`: 0..1439, minuto del día local de Lima.
 */
export interface LimaTime {
  weekday: number;
  minuteOfDay: number;
}

/**
 * Convierte un instante UTC a (weekday, minuteOfDay) en hora LOCAL de Lima desplazando -5h (sin DST).
 * Operamos sobre el epoch en minutos para que el wrap de medianoche (y el cambio de día) sea correcto
 * incluso cuando el offset cruza la frontera del día (ej. 02:00 UTC → 21:00 del día ANTERIOR en Lima).
 */
export function toLimaTime(now: Date): LimaTime {
  const utcMinutes = Math.floor(now.getTime() / 60000);
  const limaMinutes = utcMinutes + LIMA_UTC_OFFSET_MINUTES;
  // Día local de Lima (en días epoch) y minuto dentro del día, normalizados a [0, 1440).
  const dayIndex = Math.floor(limaMinutes / MINUTES_PER_DAY);
  const minuteOfDay = limaMinutes - dayIndex * MINUTES_PER_DAY;
  // 1970-01-01 (epoch día 0) fue JUEVES. ISO weekday: Lun=1..Dom=7. (dayIndex + 3) alinea jueves→4.
  const weekday = ((((dayIndex + 3) % 7) + 7) % 7) + 1;
  return { weekday, minuteOfDay };
}

/** Bit del dayMask para un weekday ISO (Lun=1 → bit 1, Mar=2 → bit 2, …, Dom=7 → bit 64). */
function dayBit(isoWeekday: number): number {
  return 1 << (isoWeekday - 1);
}

/**
 * Decisión PURA del modo (ADR 011 §1.1). Recorre las reglas EN ORDEN y devuelve el modo de la PRIMERA
 * que matchea `(día de la semana en el dayMask) AND (startMinute <= minuteOfDay < endMinute)` en hora
 * local de Lima. Si ninguna matchea → `defaultMode`. Rangos overnight (`end <= start`) NO matchean (MVP).
 *
 * `zone` se ACEPTA pero se IGNORA en el MVP (Tier 1 GLOBAL); está para que Tier 2 (overrides per-zona)
 * sea no-breaking — la firma ya transporta la zona.
 */
export function resolveMode(schedule: PricingModeSchedule, _zone: ZoneKey, now: Date): PricingMode {
  const { weekday, minuteOfDay } = toLimaTime(now);
  const todayBit = dayBit(weekday);
  for (const rule of schedule.rules) {
    // MVP: solo rangos SAME-DAY [start, end). Un rango invertido (overnight) se trata como NO-matcheante.
    if (rule.endMinute <= rule.startMinute) continue;
    const dayMatches = (rule.dayMask & todayBit) !== 0;
    const timeMatches = rule.startMinute <= minuteOfDay && minuteOfDay < rule.endMinute;
    if (dayMatches && timeMatches) return rule.mode;
  }
  return schedule.defaultMode;
}

/**
 * Mapea el origen de un viaje a su ZoneKey (ADR 011 §7 · `toZone(origin)`). MVP: SIEMPRE 'GLOBAL'
 * (Tier 1). Stub para Tier 2 (celda H3 / zona nombrada): cuando exista, resuelve la zona acá sin tocar
 * el resolver ni createTrip (la firma ya pasa la zona).
 */
export function toZone(_origin: { lat: number; lon: number }): ZoneKey {
  return 'GLOBAL';
}
