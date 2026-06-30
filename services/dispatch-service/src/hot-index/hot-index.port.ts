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
import type { FleetDocumentType, VehicleClass, VehicleSegment } from '@veo/shared-types';

export const HOT_INDEX = Symbol('HOT_INDEX');
/** Exclusión por PÁNICO (BR-T06): se limpia por resolución del incidente. */
export const EXCLUSION_REGISTRY = Symbol('EXCLUSION_REGISTRY');
/**
 * Exclusión por SUSPENSIÓN del conductor (ciclo de vida DISTINTO al de pánico: se limpia por
 * REACTIVACIÓN holds-aware, NO por-incidente). Misma interfaz `ExclusionRegistry`, otro SET de Redis.
 * El pool filtra por AMBOS; un conductor suspendido NO recibe ofertas FIXED aunque siga pingeando GPS.
 */
export const SUSPENSION_REGISTRY = Symbol('SUSPENSION_REGISTRY');

/**
 * B5-3 · atributos de eligibilidad del vehículo activo (del modelSpec elegido + el año del vehículo).
 * Todos OPCIONALES: un ping legacy (productor sin desplegar) no los trae y el pool degrada a "elegible".
 */
export interface DriverVehicleAttrs {
  /**
   * IDENTIDAD del vehículo activo (no es un attr de eligibilidad: NO filtra el matching). dispatch la usa como
   * KEY ÚNICA del carry anti-clobber: preservar attrs ausentes SOLO si el ping previo es el MISMO vehículo
   * (mismo vehicleId). vehicleType (VehicleClass) no alcanza — un XL 7-asientos y un económico 5-asientos son
   * ambos CAR. Opcional: si el ping no lo trae (fleet 204/outage ⇒ tampoco trae attrs) NO hay carry — el
   * conductor degrada honesto (cero stale, self-heal al próximo ping). Sin fallback por vehicleType (landmine
   * d.1 · ADR-017 §5(d)).
   */
  vehicleId?: string;
  seats?: number;
  segment?: VehicleSegment;
  vehicleYear?: number;
  /**
   * B5-3.2 · certificaciones de operador VIGENTES del conductor (FleetDocumentType). El pool las usa para
   * gatear las verticales FAIL-CLOSED (ambulancia exige AMBULANCE_OPERATOR). Opcional: ausente ⇒ el conductor
   * NO tiene certs conocidas ⇒ inelegible para cualquier oferta que exija una (a diferencia de seats/segment).
   */
  certifications?: FleetDocumentType[];
}

/** Ubicación vigente de un conductor disponible. */
export interface DriverLocation extends DriverVehicleAttrs {
  driverId: string;
  lat: number;
  lon: number;
  /** Celda H3 (res 9) en la que está indexado. */
  h3: string;
  /**
   * Clase de vehículo activa del conductor (ADR 013 · key del pool de matching). El matching filtra
   * por este valor: un viaje MOTO solo se ofrece a conductores MOTO.
   */
  vehicleType: VehicleClass;
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
   * `vehicleType` refleja la clase de vehículo activa del conductor; se persiste para filtrar el
   * matching por clase. OBLIGATORIO (ADR 013 · Lote D): el default legacy vive en el BORDE del evento
   * (kafka-consumers), no acá — un caller nuevo no puede "olvidar" la clase y caer silencioso a CAR.
   */
  upsertLocation(
    driverId: string,
    point: LatLon,
    vehicleType: VehicleClass,
    attrs?: DriverVehicleAttrs,
  ): Promise<DriverLocation>;
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
  /**
   * Cardinalidad de conductores EN LÍNEA ahora: cuántos tienen una ubicación viva en el índice
   * (un ping refresca el TTL; al expirar/offline desaparece). Cuenta tanto disponibles como ocupados
   * —un conductor en viaje SIGUE en línea—, sin doble conteo. KPI del dashboard admin ("conductores
   * en línea"). No se apoya en los SETs por celda (esos son solo los DISPONIBLES y exigirían unir N
   * celdas); usa la presencia de la loc como única fuente de verdad del estado "online".
   */
  countOnline(): Promise<number>;
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

export type { LatLon, VehicleClass };
