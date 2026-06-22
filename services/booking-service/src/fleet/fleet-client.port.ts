/**
 * Puerto del cliente gRPC a fleet-service (veo.fleet.v1.FleetService).
 *
 * booking lo usa en el PUBLISH para la validación ANTI-IDOR del vehículo (ADR-014 §8 · F1a): el
 * `vehicleId` lo elige el cliente, pero la PERTENENCIA se valida server-side contra el conductor
 * SERVER-TRUTH del token. Se pide la LISTA de vehículos del conductor (`GetDriverVehicles`) y se
 * verifica que el vehicleId del body esté entre los SUYOS — un conductor NO puede publicar con un
 * vehículo ajeno (familia de bug del IDOR). A diferencia de dispatch (que solo resuelve el vehículo
 * activo), acá importa la lista completa para el ownership-check.
 *
 * (D de SOLID: el gate depende de esta interfaz, no de @grpc/grpc-js. En tests se inyecta un fake.)
 * POLÍTICA fail-closed: si fleet no responde, la implementación LANZA y el gate RECHAZA la publicación
 * (ForbiddenError) — nunca un vehículo no validado colándose por un error de red.
 */
export const FLEET_CLIENT = Symbol('FLEET_CLIENT');

/** Vista de un vehículo del conductor según fleet-service (lectura síncrona por gRPC). */
export interface FleetVehicle {
  id: string;
  /** Estado de los documentos: PENDING_REVIEW | VALID | EXPIRING_SOON | EXPIRED | REJECTED. */
  docStatus: string;
  /** El conductor lo tiene activo (operable). */
  active: boolean;
  /** Estado de revisión derivado: PENDING_REVIEW | ACTIVE. ACTIVE habilita operar. */
  status: string;
  /** Tipo de vehículo: CAR | MOTO. */
  vehicleType: string;
}

/**
 * Vista PÚBLICA de un vehículo por id (campos visibles al pasajero · minimización H8): modelo/placa/color
 * para reconocer el auto. La consume el DETALLE de un viaje (GET /published-trips/:id, F2). `found=false`
 * si fleet no encontró el vehículo.
 */
export interface PublicVehicle {
  id: string;
  make: string;
  model: string;
  color: string;
  plate: string;
  vehicleType: string;
  found: boolean;
}

export interface FleetClient {
  /**
   * Lista los vehículos registrados por el conductor (id = driverId; fleet indexa por el sujeto de la
   * identidad propagada). Lista vacía si no tiene ninguno. Anti-IDOR: SIEMPRE se llama con el driverId
   * server-truth, nunca con un valor del cliente.
   */
  getDriverVehicles(driverId: string): Promise<FleetVehicle[]>;

  /**
   * Lee UN vehículo por su id (datos PÚBLICOS: modelo/placa/color) para enriquecer el detalle de un viaje
   * (F2). `null` si fleet no responde o no lo encuentra — el detalle degrada honesto (vehículo no resuelto),
   * no se cuelga.
   */
  getVehicle(vehicleId: string): Promise<PublicVehicle | null>;
}
