import type {RegistrationRepository} from '../repositories/registration-repository';
import type {VehicleData, VehicleRegisterInput, VehicleView} from '../entities';

/**
 * Código de error de validación por campo del vehículo. El dominio NO conoce i18n: emite códigos
 * estables y la presentación los traduce (`registration.vehicle.errors.<code>`).
 */
export type VehicleFieldError =
  | 'plate_required'
  | 'plate_invalid'
  | 'make_required'
  | 'make_too_long'
  | 'model_required'
  | 'model_too_long'
  | 'year_invalid';

/** Errores de validación por campo del vehículo. */
export interface VehicleErrors {
  plate?: VehicleFieldError;
  brand?: VehicleFieldError;
  model?: VehicleFieldError;
  year?: VehicleFieldError;
}

/** Resultado de validar/mapear los datos del wizard al body del contrato. */
export type VehicleValidation =
  | {ok: true; request: VehicleRegisterInput}
  | {ok: false; errors: VehicleErrors};

/** Longitud máxima de marca/modelo (coherente con `registerVehicleRequest`). */
const MAX_TEXT_LENGTH = 60;
/** Año mínimo aceptado por el contrato (`registerVehicleRequest.year`). fleet aplica BR-D04 (>=2017). */
const MIN_VEHICLE_YEAR = 2005;

/** Placa peruana: 3 caracteres alfanuméricos + 3 (guion opcional). fleet la normaliza y revalida. */
const PLATE_PATTERN = /^[A-Z0-9]{3}-?[A-Z0-9]{3}$/;

/**
 * Valida y mapea los datos del vehículo del wizard al body de `POST /drivers/vehicles`. Lógica pura
 * y testeable: normaliza la placa (mayúsculas, sin espacios), convierte el año a número y recorta
 * marca/modelo. Coherente con `registerVehicleRequest` del contrato.
 */
export function validateVehicle(vehicle: VehicleData): VehicleValidation {
  const errors: VehicleErrors = {};

  const plate = vehicle.plate.trim().toUpperCase().replace(/\s+/g, '');
  if (plate.length === 0) {
    errors.plate = 'plate_required';
  } else if (!PLATE_PATTERN.test(plate)) {
    errors.plate = 'plate_invalid';
  }

  const make = vehicle.brand.trim();
  if (make.length === 0) {
    errors.brand = 'make_required';
  } else if (make.length > MAX_TEXT_LENGTH) {
    errors.brand = 'make_too_long';
  }

  const model = vehicle.model.trim();
  if (model.length === 0) {
    errors.model = 'model_required';
  } else if (model.length > MAX_TEXT_LENGTH) {
    errors.model = 'model_too_long';
  }

  const year = Number(vehicle.year.trim());
  const maxYear = new Date().getUTCFullYear() + 1;
  const isValidYear =
    Number.isInteger(year) && year >= MIN_VEHICLE_YEAR && year <= maxYear;
  if (!isValidYear) {
    errors.year = 'year_invalid';
  }

  if (errors.plate || errors.brand || errors.model || errors.year) {
    return {ok: false, errors};
  }
  return {ok: true, request: {vehicleType: vehicle.type, plate, make, model, year}};
}

/**
 * Caso de uso: registra el vehículo del conductor. Valida en cliente antes de delegar en el
 * repositorio (abstracción). Lanza `VehicleValidationError` con los errores por campo si la
 * validación falla, para que la presentación los muestre junto a cada campo.
 */
export class RegisterVehicleUseCase {
  constructor(private readonly repository: RegistrationRepository) {}

  execute(vehicle: VehicleData): Promise<VehicleView> {
    const validation = validateVehicle(vehicle);
    if (!validation.ok) {
      return Promise.reject(new VehicleValidationError(validation.errors));
    }
    return this.repository.registerVehicle(validation.request);
  }
}

/** Error de validación de cliente del vehículo (transporta los errores por campo). */
export class VehicleValidationError extends Error {
  constructor(readonly errors: VehicleErrors) {
    super('Datos del vehículo inválidos');
    this.name = 'VehicleValidationError';
  }
}
