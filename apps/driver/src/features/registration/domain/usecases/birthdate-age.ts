/**
 * Regla de edad del conductor (BR-I04), fuente única para el picker y la validación de dominio.
 *
 * Replica EXACTAMENTE el validador del backend (`identity-service` →
 * `src/common/is-plausible-birth-date.ts`): la edad cumplida debe estar en [18, 100] años, ambos
 * límites inclusivos. El backend es la fuente de verdad; la app debe ser igual o MÁS estricta,
 * nunca más laxa. Si esto cambia en el backend, sincronizar acá.
 */

/** Edad mínima del conductor (mayoría de edad). Espejo de `MIN_DRIVER_AGE_YEARS` del backend. */
export const MIN_DRIVER_AGE_YEARS = 18;
/** Edad máxima plausible (sanity check anti-typo). Espejo de `MAX_DRIVER_AGE_YEARS` del backend. */
export const MAX_DRIVER_AGE_YEARS = 100;

/**
 * Edad cumplida en años entre `birth` y `now`, comparando solo el día calendario (UTC) para ser
 * determinista. Mismo criterio mes/día que el backend: restar un año si aún no se alcanzó el
 * cumpleaños de este año.
 */
export function ageInYears(birth: Date, now: Date): number {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * true si la edad cumplida de `birth` respecto de `now` cae en [MIN, MAX] (ambos inclusivos).
 * No valida formato ni futuro: eso lo cubre el resto de `validatePersonalData`.
 */
export function isAgeWithinDriverRange(birth: Date, now: Date): boolean {
  const age = ageInYears(birth, now);
  return age >= MIN_DRIVER_AGE_YEARS && age <= MAX_DRIVER_AGE_YEARS;
}

/**
 * Fecha de nacimiento MÁS RECIENTE aceptada respecto de `now`: la que da exactamente
 * `MIN_DRIVER_AGE_YEARS` años cumplidos hoy (hoy menos 18 años). Acota el `maximumDate` del picker.
 */
export function maxBirthDate(now: Date = new Date()): Date {
  return new Date(now.getFullYear() - MIN_DRIVER_AGE_YEARS, now.getMonth(), now.getDate());
}

/**
 * Fecha de nacimiento MÁS ANTIGUA aceptada respecto de `now`: la que da exactamente
 * `MAX_DRIVER_AGE_YEARS` años cumplidos hoy (hoy menos 100 años). Acota el `minimumDate` del picker.
 */
export function minBirthDate(now: Date = new Date()): Date {
  return new Date(now.getFullYear() - MAX_DRIVER_AGE_YEARS, now.getMonth(), now.getDate());
}
