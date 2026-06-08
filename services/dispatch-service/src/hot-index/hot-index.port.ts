/**
 * Puertos del "hot index" de conductores (BR-T06).
 *
 * El estado de disponibilidad/ubicación de los conductores vive en Redis (no en Postgres):
 * baja latencia y expiración automática por TTL. Estos puertos son la abstracción inyectable;
 * la implementación de producción es `RedisHotIndex`/`RedisExclusionRegistry` (Redis real con LUA),
 * y en tests unitarios se usa un fake en memoria que respeta el MISMO contrato.
 *
 * (D de SOLID: el dominio depende de estas interfaces, no de ioredis directamente.)
 */
import type { LatLon } from '@veo/utils';
import type { VehicleType } from '@veo/shared-types';

export const HOT_INDEX = Symbol('HOT_INDEX');
export const EXCLUSION_REGISTRY = Symbol('EXCLUSION_REGISTRY');

/** Ubicación vigente de un conductor disponible. */
export interface DriverLocation {
  driverId: string;
  lat: number;
  lon: number;
  /** Celda H3 (res 9) en la que está indexado. */
  h3: string;
  /**
   * Tipo de vehículo activo del conductor (Ola 2B · tier moto-taxi). El matching filtra por este
   * valor: un viaje MOTO solo se ofrece a conductores MOTO. Default CAR si el ping no lo trae.
   */
  vehicleType: VehicleType;
  /** epoch(ms) del último ping. */
  updatedAt: number;
}

/**
 * Índice geoespacial caliente. Mantiene, por celda H3, el SET de conductores disponibles,
 * y por conductor su ubicación con TTL. Mover un conductor entre celdas debe ser atómico.
 */
export interface HotIndex {
  /**
   * Ingiere un ping de ubicación (consumido de `driver.location_updated`). Mueve de celda si cambió.
   * `vehicleType` (Ola 2B) refleja el vehículo activo del conductor; se persiste para filtrar el
   * matching por tipo. Default CAR si no se provee.
   */
  upsertLocation(driverId: string, point: LatLon, vehicleType?: VehicleType): Promise<DriverLocation>;
  /** Marca al conductor como ocupado (asignado / en viaje): sale del pool disponible. */
  markBusy(driverId: string): Promise<void>;
  /** Reincorpora al conductor al pool disponible en su última celda conocida. */
  markAvailable(driverId: string): Promise<void>;
  /** Elimina por completo al conductor del índice (fin de turno / offline). */
  remove(driverId: string): Promise<void>;
  getLocation(driverId: string): Promise<DriverLocation | null>;
  /** Conductores disponibles (ubicación viva) en cualquiera de las celdas dadas. */
  candidates(cells: string[]): Promise<DriverLocation[]>;
  /**
   * MUESTRA ACOTADA de conductores disponibles en las celdas dadas: devuelve A LO SUMO `limit`
   * (sin garantía de ser los más cercanos). Para feeds de AMBIENTE de alta frecuencia (mapa del
   * pasajero) donde traer TODO el set de una celda densa para luego capear sería derrochar Redis+CPU.
   * A diferencia de `candidates()` (que el matching necesita COMPLETO para rankear), acota el costo
   * a ~`limit` en origen (muestreo en Redis), no en memoria del proceso.
   */
  availableSample(cells: string[], limit: number): Promise<DriverLocation[]>;
}

/**
 * Registro de exclusión por prioridad de pánico (BR-T06): un conductor excluido no recibe
 * nuevas ofertas hasta su resolución. No hay reasignación automática.
 */
export interface ExclusionRegistry {
  exclude(driverId: string): Promise<void>;
  isExcluded(driverId: string): Promise<boolean>;
  /** Devuelve solo los conductores NO excluidos (preserva el orden de entrada). */
  filter(driverIds: string[]): Promise<string[]>;
  clear(driverId: string): Promise<void>;
}

export type { LatLon, VehicleType };
