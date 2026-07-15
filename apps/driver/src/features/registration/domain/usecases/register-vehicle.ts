import { PLATE_PATTERN } from '@veo/shared-types';
import type { RegistrationRepository } from '../repositories/registration-repository';
import type { VehicleData, VehicleRegisterInput, VehicleView } from '../entities';

/**
 * Código de error de validación por campo del vehículo. El dominio NO conoce i18n: emite códigos
 * estables y la presentación los traduce (`registration.vehicle.errors.<code>`).
 * B5-2: marca/modelo ya no son texto libre — el conductor ELIGE del catálogo, así que el error de
 * modelo es "no elegiste un modelo" (`model_not_selected`), no longitud/requerido de texto.
 */
export type VehicleFieldError =
  | 'plate_required'
  | 'plate_invalid'
  // Conflicto del servidor (409): la placa pertenece a OTRO conductor. La idempotencia del backend ya
  // deja pasar la placa PROPIA, así que un 409 que llega a la app es siempre "placa ajena".
  | 'plate_taken'
  | 'model_not_selected'
  | 'year_invalid'
  // LOTE 1: no se derivó (categoría no leída/no soportada) ni se eligió el tipo a mano → no hay tipo que
  // enviar. La UI ya gatea el botón con esto; este error es la red de seguridad del dominio (sin "Auto" mudo).
  | 'type_required';

/** Errores de validación por campo del vehículo. */
export interface VehicleErrors {
  plate?: VehicleFieldError;
  model?: VehicleFieldError;
  year?: VehicleFieldError;
  type?: VehicleFieldError;
}

/** Resultado de validar/mapear los datos del wizard al body del contrato. */
export type VehicleValidation =
  | { ok: true; request: VehicleRegisterInput }
  | { ok: false; errors: VehicleErrors };

/** Año mínimo aceptado por el contrato (`registerVehicleRequest.year`). fleet aplica BR-D04 (>=2017). */
const MIN_VEHICLE_YEAR = 2005;

/**
 * ¿El año (texto del wizard) cae en el rango ACEPTADO por el contrato (`MIN_VEHICLE_YEAR`..año actual+1)?
 * Predicado PURO y única fuente de verdad del rango: lo usa `validateVehicle` (gating del alta) y el flujo
 * scan-first (`useScanPropertyCard`) para decidir si un año leído por OCR es PRELLENABLE o debe quedar
 * CORREGIBLE (el parser del OCR acepta 1950..2099, más laxo que el contrato). Evita prellenar un año que el
 * alta va a rechazar y mostrar un falso "capturada ✓".
 */
export function isVehicleYearValid(year: string): boolean {
  const n = Number(year.trim());
  const maxYear = new Date().getUTCFullYear() + 1;
  return Number.isInteger(n) && n >= MIN_VEHICLE_YEAR && n <= maxYear;
}

/** Longitud máxima de `make`/`model` a texto libre del contrato (`registerVehicleRequest`: 1..60). */
const FREETEXT_MAX = 60;

/** Longitud máxima del `color` del contrato (`registerVehicleRequest.color`: 1..30). */
const COLOR_MAX = 30;

/**
 * Valida y mapea los datos del vehículo del wizard al body de `POST /drivers/vehicles`. Lógica pura
 * y testeable: normaliza la placa (mayúsculas, sin espacios) y convierte el año a número.
 *
 * DOS RAMAS del contrato (`registerVehicleRequest.refine`: `modelSpecId` O bien `make`+`model`):
 *  - RAMA CATÁLOGO (B5-2 · selección manual): el conductor ELIGE un modelo del catálogo → el body lleva
 *    `modelSpecId` y el backend snapshotea make/model/vehicleType del spec (ignora texto libre).
 *  - RAMA TEXTO LIBRE (Lote 2 · scan-first): el OCR de la tarjeta de propiedad leyó make/model como TEXTO
 *    y NO hay `modelSpecId` (el catálogo aún no tiene fuzzy-match — Lote 3). El body lleva `make`+`model`
 *    a texto libre y el backend toma `vehicleType` derivado de la categoría MTC del documento.
 *
 * El gating de "modelo" se satisface con CUALQUIERA de las dos ramas: hay `modelSpecId`, o hay make+model.
 * Si no hay ninguna → `model_not_selected` (sin modelo el vehículo no se puede registrar).
 */
export function validateVehicle(vehicle: VehicleData): VehicleValidation {
  const errors: VehicleErrors = {};

  const plate = vehicle.plate.trim().toUpperCase().replace(/\s+/g, '');
  if (plate.length === 0) {
    errors.plate = 'plate_required';
  } else if (!PLATE_PATTERN.test(plate)) {
    errors.plate = 'plate_invalid';
  }

  const modelSpecId = vehicle.modelSpecId.trim();
  // Texto libre del OCR (scan-first): recortado a los 60 chars del contrato (`make`/`model` 1..60).
  const make = vehicle.brand.trim().slice(0, FREETEXT_MAX);
  const model = vehicle.model.trim().slice(0, FREETEXT_MAX);
  const hasCatalogModel = modelSpecId.length > 0;
  const hasFreetextModel = make.length > 0 && model.length > 0;
  if (!hasCatalogModel && !hasFreetextModel) {
    errors.model = 'model_not_selected';
  }

  const year = Number(vehicle.year.trim());
  if (!isVehicleYearValid(vehicle.year)) {
    errors.year = 'year_invalid';
  }

  // LOTE 1: SIN seed "Auto". Sin un tipo derivado de la tarjeta o elegido a mano (`null`) no hay nada que
  // enviar — el alta no asume tipo. La UI ya bloquea el botón; esto evita un envío sin tipo si se sortea.
  const vehicleType = vehicle.type;
  if (vehicleType === null) {
    errors.type = 'type_required';
  }

  // El return sobre `vehicleType === null` (no solo `errors.type`) hace que TS NARROWEE `vehicleType` a un
  // `VehicleType` no nulo en el resto de la función (el chequeo de `errors.type` no liga el tipo por sí solo).
  if (vehicleType === null || errors.plate || errors.model || errors.year) {
    return { ok: false, errors };
  }
  // LOTE 1: la categoría MTC cruda de la tarjeta viaja como FUENTE DE VERDAD del tipo (el servidor deriva
  // `vehicleType` de acá). Vacía en la carga manual → se omite del body (queda el `vehicleType` como hint).
  const mtcCategory = vehicle.mtcCategory.trim();
  const mtcField = mtcCategory.length > 0 ? { mtcCategory } : {};
  // Color de carrocería (leído por OCR de la tarjeta o vacío en la carga manual): opcional en el contrato,
  // recortado a los 30 chars de `registerVehicleRequest.color`. Vacío → se omite del body (no se envía '').
  const color = vehicle.color.trim().slice(0, COLOR_MAX);
  const colorField = color.length > 0 ? { color } : {};
  // RAMA CATÁLOGO gana si hay `modelSpecId` (el backend snapshotea del spec e IGNORA el texto libre).
  // Si no, RAMA TEXTO LIBRE: viaja make+model (Lote 3 hará fuzzy-match a catálogo + crecimiento del mismo).
  const request: VehicleRegisterInput = hasCatalogModel
    ? { vehicleType, plate, year, modelSpecId, ...mtcField, ...colorField }
    : { vehicleType, plate, year, make, model, ...mtcField, ...colorField };
  return { ok: true, request };
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
