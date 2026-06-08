import type {RegistrationRepository} from '../repositories/registration-repository';
import type {PersonalData, PersonalDataInput, PersonalDataView} from '../entities';

/**
 * Código de error de validación por campo de datos personales. El dominio NO conoce i18n: emite
 * códigos estables y la presentación los traduce (`registration.personal.errors.<code>`).
 */
export type PersonalDataFieldError =
  | 'name_required'
  | 'name_too_long'
  | 'dni_invalid'
  | 'birthdate_required'
  | 'birthdate_invalid'
  | 'birthdate_future';

/** Errores de validación por campo (los presentes se muestran junto a su campo). */
export interface PersonalDataErrors {
  fullName?: PersonalDataFieldError;
  dni?: PersonalDataFieldError;
  birthdate?: PersonalDataFieldError;
}

/** Resultado de validar/mapear los datos del wizard al body del contrato. */
export type PersonalDataValidation =
  | {ok: true; request: PersonalDataInput}
  | {ok: false; errors: PersonalDataErrors};

/** Longitud máxima del nombre legal (coherente con `driverPersonalDataRequest.legalName`). */
const MAX_NAME_LENGTH = 120;
/** Año mínimo razonable de nacimiento (evita fechas absurdas; el backend valida el formato). */
const MIN_BIRTH_YEAR = 1920;

/** Extrae solo dígitos de una cadena (DNI con espacios de presentación, fecha con separadores). */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Valida y mapea los datos personales del wizard al body de `PATCH /drivers/me/personal`. Lógica
 * pura y testeable (sin red ni UI): normaliza el DNI (8 dígitos), convierte la fecha DD/MM/AAAA a
 * `yyyy-mm-dd` y recorta el nombre. Coherente con `driverPersonalDataRequest` del contrato.
 */
export function validatePersonalData(personal: PersonalData): PersonalDataValidation {
  const errors: PersonalDataErrors = {};

  const legalName = personal.fullName.trim();
  if (legalName.length === 0) {
    errors.fullName = 'name_required';
  } else if (legalName.length > MAX_NAME_LENGTH) {
    errors.fullName = 'name_too_long';
  }

  const dni = digitsOnly(personal.dni);
  if (!/^\d{8}$/.test(dni)) {
    errors.dni = 'dni_invalid';
  }

  const birthDate = toIsoBirthDate(personal.birthdate, errors);

  if (errors.fullName || errors.dni || errors.birthdate) {
    return {ok: false, errors};
  }
  return {ok: true, request: {legalName, dni, birthDate: birthDate as string}};
}

/**
 * Convierte una fecha escrita como DD/MM/AAAA (con o sin separadores) a `yyyy-mm-dd`. Registra el
 * error correspondiente en `errors.birthdate` y devuelve `null` si no es una fecha real o es futura.
 */
function toIsoBirthDate(raw: string, errors: PersonalDataErrors): string | null {
  const digits = digitsOnly(raw);
  if (digits.length === 0) {
    errors.birthdate = 'birthdate_required';
    return null;
  }
  if (digits.length !== 8) {
    errors.birthdate = 'birthdate_invalid';
    return null;
  }

  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const year = Number(digits.slice(4, 8));

  const isRealDate =
    year >= MIN_BIRTH_YEAR &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month);
  if (!isRealDate) {
    errors.birthdate = 'birthdate_invalid';
    return null;
  }

  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  // Rechaza fechas futuras comparando solo el día calendario (UTC) para evitar desfases de zona.
  const today = new Date();
  const todayIso = `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}-${pad2(
    today.getUTCDate(),
  )}`;
  if (iso > todayIso) {
    errors.birthdate = 'birthdate_future';
    return null;
  }
  return iso;
}

/** Días del mes considerando años bisiestos (validación de fecha real). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Formatea un número a dos dígitos (mes/día). */
function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Caso de uso: persiste los datos personales del conductor. Valida en cliente antes de delegar en
 * el repositorio (abstracción). Lanza `PersonalDataValidationError` con los errores por campo si la
 * validación de cliente falla, para que la presentación los muestre junto a cada campo.
 */
export class UpdatePersonalDataUseCase {
  constructor(private readonly repository: RegistrationRepository) {}

  execute(personal: PersonalData): Promise<PersonalDataView> {
    const validation = validatePersonalData(personal);
    if (!validation.ok) {
      return Promise.reject(new PersonalDataValidationError(validation.errors));
    }
    return this.repository.updatePersonalData(validation.request);
  }
}

/** Error de validación de cliente de datos personales (transporta los errores por campo). */
export class PersonalDataValidationError extends Error {
  constructor(readonly errors: PersonalDataErrors) {
    super('Datos personales inválidos');
    this.name = 'PersonalDataValidationError';
  }
}
