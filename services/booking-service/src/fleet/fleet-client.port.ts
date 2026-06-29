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
  /** Estado documental AGREGADO del vehículo (eje de VENCIMIENTO, enum VehicleDocStatus): VALID | EXPIRING_SOON
   *  | EXPIRED. (PENDING_REVIEW/REJECTED son del enum per-documento FleetDocumentStatus, no del agregado.) */
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

/**
 * Vista de un vehículo por id que une los campos PÚBLICOS de display (modelo/placa/color) con los ejes de
 * OPERABILIDAD (`active`/`status`/`docStatus`) — exactamente lo que `VehicleReply` ya trae por el wire. La
 * consume el DETALLE y la RESERVA: el display alimenta la cara pública de la oferta y los ejes de operabilidad
 * alimentan el GATE fail-closed (`isVehicleOperable`, fuente única con el publish). Es un superconjunto de
 * `PublicVehicle` (display) y de `VehicleOperabilityView` (operabilidad) — ambos se derivan de ella sin re-pedir
 * a fleet (UNA sola llamada gRPC cubre display + gate). `found=false` si fleet no encontró el vehículo.
 */
export interface FleetVehicleView {
  id: string;
  make: string;
  model: string;
  color: string;
  plate: string;
  vehicleType: string;
  found: boolean;
  /** Eje de operabilidad: el conductor lo tiene activo. */
  active: boolean;
  /** Eje de operabilidad: estado de revisión derivado (VehicleReply.status): ACTIVE | PENDING_REVIEW. */
  status: string;
  /** Eje de operabilidad: estado documental AGREGADO (VehicleDocStatus): VALID | EXPIRING_SOON | EXPIRED. */
  docStatus: string;
}

export interface FleetClient {
  /**
   * Lista los vehículos registrados por el conductor (id = driverId; fleet indexa por el sujeto de la
   * identidad propagada). Lista vacía si no tiene ninguno. Anti-IDOR: SIEMPRE se llama con el driverId
   * server-truth, nunca con un valor del cliente.
   */
  getDriverVehicles(driverId: string): Promise<FleetVehicle[]>;

  /**
   * Lee UN vehículo por su id (display PÚBLICO + ejes de OPERABILIDAD) para el DETALLE y la RESERVA. El detalle
   * lo usa para DOS cosas en UNA sola llamada: enriquecer la cara pública (modelo/placa/color) Y gatear la
   * operabilidad fail-closed (`isVehicleOperable`). La vista trae `found=false` si fleet no encontró el vehículo.
   * POLÍTICA fail-closed: LANZA ante fallo de transporte de fleet — el caller traduce a "oferta no ofertable"
   * (no se ofrece/reserva un vehículo cuya operabilidad no se pudo verificar; espeja el gate del conductor).
   */
  getVehicle(vehicleId: string): Promise<FleetVehicleView>;

  /**
   * Lee VARIOS vehículos por id en UNA llamada (anti-N+1 · Lote 3b). La usa la BÚSQUEDA para filtrar las ofertas
   * cuyo vehículo dejó de ser operable. Devuelve un Map vehicleId→vista SOLO de los ENCONTRADOS; un id ausente
   * del map = no encontrado en fleet = el caller lo trata como NO operable (VERIFICADO-MALO, se descarta). LANZA
   * ante fallo de transporte — el caller (búsqueda) decide la política: es BEST-EFFORT (fleet caída → NO-VERIFICABLE
   * → no filtra por vehículo, la card viaja degradada), IGUAL que el enriquecimiento del conductor. El gate de dinero
   * real es detalle (404) y reserva (409/502), ambos fail-closed: la búsqueda solo MUESTRA, no autoriza.
   */
  getVehiclesOperability(vehicleIds: readonly string[]): Promise<Map<string, FleetVehicleView>>;
}

