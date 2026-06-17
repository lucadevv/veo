/**
 * Validador de fecha de nacimiento plausible (BR-I04): un `yyyy-mm-dd` que NO sea futuro y que dé una
 * edad razonable (entre 18 y 100 años). Evita typos groseros (1899, 2099) y menores de edad sin
 * acoplar el DTO a una librería de fechas. Se compara a medianoche UTC para ser determinista.
 */
import {
  registerDecorator,
  type ValidationOptions,
  type ValidationArguments,
} from 'class-validator';

/** Edad mínima del conductor (mayoría de edad). */
export const MIN_DRIVER_AGE_YEARS = 18;
/** Edad máxima plausible (sanity check anti-typo). */
export const MAX_DRIVER_AGE_YEARS = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Calcula la edad cumplida en años entre `birth` y `now` (ambos a medianoche UTC). */
function ageInYears(birth: Date, now: Date): number {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/** true si `value` es un yyyy-mm-dd válido, no futuro y con edad en [MIN, MAX]. */
export function isPlausibleBirthDate(value: unknown, now: Date = new Date()): boolean {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;

  // Parse UTC explícito; rechaza fechas imposibles (ej. 2024-02-31 → normaliza distinto).
  const birth = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(birth.getTime())) return false;
  if (birth.toISOString().slice(0, 10) !== value) return false;

  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (birth.getTime() > today.getTime()) return false; // futuro

  const age = ageInYears(birth, today);
  return age >= MIN_DRIVER_AGE_YEARS && age <= MAX_DRIVER_AGE_YEARS;
}

/**
 * Decorador de propiedad: valida que `birthDate` (yyyy-mm-dd) no sea futuro y dé una edad plausible
 * (18–100 años). Úsalo junto a `@Matches(/^\d{4}-\d{2}-\d{2}$/)` para el formato.
 */
export function IsPlausibleBirthDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isPlausibleBirthDate',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isPlausibleBirthDate(value);
        },
        defaultMessage(_args: ValidationArguments): string {
          return `birthDate debe ser una fecha pasada con edad entre ${MIN_DRIVER_AGE_YEARS} y ${MAX_DRIVER_AGE_YEARS} años`;
        },
      },
    });
  };
}
