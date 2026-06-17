/**
 * Helpers PUROS del modo de pricing (PUJA↔FIJO · ADR 011). Sin React ni I/O: solo formateo del
 * contrato `modeScheduleView` para la UI. Viven aquí (no en el componente) para ser testeables y
 * reutilizables (clean: la presentación no calcula, consume).
 */
import { isPujaMode } from '@veo/shared-types';
import type { PricingMode } from '@/lib/api/schemas';

/** Etiqueta humana de cada modo. PUJA = el pasajero oferta; FIJO = tarifa calculada. */
export function modeLabel(mode: PricingMode): string {
  return isPujaMode(mode) ? 'Puja' : 'Precio fijo';
}

/** Descripción de una línea para cada modo (qué implica comercialmente). */
export function modeDescription(mode: PricingMode): string {
  return isPujaMode(mode)
    ? 'El pasajero propone su tarifa y los conductores la aceptan o contraofertan (estilo inDrive).'
    : 'VEO calcula la tarifa (base + distancia + tiempo). El pasajero no negocia.';
}

/**
 * Bits del bitmask de días del schedule (Lun=1 … Dom=64). Orden de visualización empieza en Lunes,
 * coherente con la semana laboral peruana.
 */
const DAY_BITS: readonly { bit: number; short: string }[] = [
  { bit: 1, short: 'Lun' },
  { bit: 2, short: 'Mar' },
  { bit: 4, short: 'Mié' },
  { bit: 8, short: 'Jue' },
  { bit: 16, short: 'Vie' },
  { bit: 32, short: 'Sáb' },
  { bit: 64, short: 'Dom' },
];

/** Días activos del bitmask como etiquetas cortas ('Lun, Mar, …'). Vacío si ninguno (no debería). */
export function formatDayMask(mask: number): string {
  const days = DAY_BITS.filter(({ bit }) => (mask & bit) !== 0).map(({ short }) => short);
  return days.length === 7 ? 'Todos los días' : days.join(', ');
}

/** Minuto del día (0-1439) → 'HH:MM' (zona Lima; el backend ya trabaja en hora local). */
export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Ventana horaria de una regla: 'HH:MM–HH:MM'. */
export function formatWindow(startMinute: number, endMinute: number): string {
  return `${formatMinute(startMinute)}–${formatMinute(endMinute)}`;
}
