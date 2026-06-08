/**
 * Tipo de vehículo con el que el conductor está operando en el turno actual (Ola 2B · tier moto-taxi).
 *
 * El backend hace matching por tipo: un viaje MOTO solo se ofrece a conductores cuyo reporte de
 * ubicación declara `vehicleType: 'MOTO'`. La app del conductor declara este valor y lo propaga en
 * el reporte de ubicación del socket `/driver`. Coincide con el enum del contrato
 * (`driverLocationReport.vehicleType`, `@veo/api-client`).
 */
export type VehicleType = 'CAR' | 'MOTO';

/** Tipo por defecto: Auto. Si el conductor nunca eligió, opera como CAR (compat con el dispatch). */
export const DEFAULT_VEHICLE_TYPE: VehicleType = 'CAR';

/** Lista canónica para iterar en la UI (orden de presentación: Auto primero). */
export const VEHICLE_TYPES: readonly VehicleType[] = ['CAR', 'MOTO'] as const;

/**
 * Normaliza un valor crudo (p. ej. recuperado de MMKV) a un `VehicleType` conocido.
 * Tolerante a valores ausentes o corruptos: degrada a `DEFAULT_VEHICLE_TYPE`.
 */
export function parseVehicleType(raw: string | undefined | null): VehicleType {
  return raw === 'MOTO' || raw === 'CAR' ? raw : DEFAULT_VEHICLE_TYPE;
}
