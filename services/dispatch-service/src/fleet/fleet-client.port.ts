/**
 * Puerto del cliente gRPC a fleet-service (veo.fleet.v1.FleetService).
 *
 * dispatch lo usa al ACEPTAR una oferta (awarding) para resolver el vehículo ACTIVO del conductor y
 * adjuntarlo al evento `dispatch.match_found` → así el viaje queda con su `vehicleId` (trazabilidad
 * viaje→vehículo, Ley 29733) y la app puede mostrar placa/modelo/color sin re-enriquecer.
 *
 * (D de SOLID: dispatch depende de esta interfaz, no de @grpc/grpc-js. En tests se inyecta un fake.)
 * POLÍTICA: la implementación LANZA ante fallo de fleet; el caller (accept) decide fail-soft (la
 * asignación NUNCA se bloquea por fleet: degradación honesta → vehicleId null).
 */
export const FLEET_CLIENT = Symbol('FLEET_CLIENT');

export interface FleetClient {
  /** Id del vehículo ACTIVO del conductor (o el primero si ninguno marca activo); null si no tiene. */
  getActiveVehicleId(driverId: string): Promise<string | null>;
}
