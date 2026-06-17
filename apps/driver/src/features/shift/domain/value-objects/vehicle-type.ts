/**
 * Tipo de vehículo con el que el conductor está operando en el turno actual (Ola 2B · tier moto-taxi).
 *
 * Re-export del enum CANÓNICO `VehicleClass` de `@veo/shared-types` (ADR 013 §1.6: las definiciones
 * locales mueren; la fuente única es el catálogo). El backend hace matching por clase: un viaje MOTO
 * solo se ofrece a conductores cuyo reporte de ubicación declara `vehicleType: 'MOTO'`. La app del
 * conductor declara este valor y lo propaga en el reporte de ubicación del socket `/driver`. El wire
 * field sigue siendo `vehicleType` (`driverLocationReport.vehicleType`, `@veo/api-client`).
 */
import { VehicleClass } from '@veo/shared-types';

export const VehicleType = VehicleClass;
export type VehicleType = VehicleClass;

/** Tipo por defecto: Auto. Si el conductor nunca eligió, opera como CAR (compat con el dispatch). */
export const DEFAULT_VEHICLE_TYPE: VehicleType = VehicleClass.CAR;

/** Lista canónica para iterar en la UI (orden del enum: Auto primero). */
export const VEHICLE_TYPES: readonly VehicleType[] = Object.values(VehicleClass);

/** Valores conocidos (los del enum canónico). Un string fuera de aquí degrada al default. */
const KNOWN: ReadonlySet<string> = new Set(VEHICLE_TYPES);

/**
 * Normaliza un valor crudo (p. ej. recuperado de MMKV) a un `VehicleType` conocido, validando
 * contra el enum canónico. Tolerante a valores ausentes o corruptos: degrada a `DEFAULT_VEHICLE_TYPE`.
 */
export function parseVehicleType(raw: string | undefined | null): VehicleType {
  return raw != null && KNOWN.has(raw) ? (raw as VehicleType) : DEFAULT_VEHICLE_TYPE;
}
