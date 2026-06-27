/**
 * PublishedTripsService — orquesta el ciclo del lado-CONDUCTOR de una oferta de carpooling
 * (ADR-014 §2.1, §4.1, §8): publicar · editar · cancelar · listar las propias.
 *
 * La oferta nace en BORRADOR y se publica en el MISMO acto: la transición BORRADOR→PUBLICADO pasa por la
 * máquina de estados TIPADA (`publishedTripMachine.assertTransition`) — CERO strings mágicos, la regla no
 * es un `if`. La mutación + el evento van en la MISMA transacción (outbox, §7).
 *
 * F1a (este lote) — GATES DE SEGURIDAD:
 *  - Gate del conductor en PUBLISH: re-validación server-side contra identity (GetDriver) antes de escribir
 *    — found, no-suspendido, currentStatus≠SUSPENDED, KYC VERIFIED, antecedentes CLEARED. FALLA-CERRADO si
 *    identity no responde (ForbiddenError). El estado AUTORITATIVO vive en identity, NO en el token.
 *  - Validación ANTI-IDOR del vehículo: el vehicleId lo elige el cliente, la PERTENENCIA se valida
 *    server-side contra el conductor SERVER-TRUTH (GetDriverVehicles). Vehículo ajeno → ForbiddenError.
 *    Vehículo propio pero no vigente (inactivo / status no operable / docs no VALID) → ValidationError.
 *  - Editar / cancelar / listar: ownership SIEMPRE contra el driverId server-truth del JWT, nunca del
 *    cliente. Ownership-miss → NotFoundError (no filtra existencia, mismo patrón anti-IDOR que getById).
 *
 * DIFERIDO (degradación honesta, ADR-014):
 *  - La búsqueda geo (índice H3, GET por ruta+fecha) es F2: lee por id, no busca.
 *  - El tope de cost-sharing por distancia (precioBase ≤ tope) es F1b.
 *  - El fan-out de Refund a las reservas activas al cancelar es F3.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isUuid,
  uuidv7,
  toH3,
  neighbors,
  DISPATCH_H3_RESOLUTION,
} from '@veo/utils';
import { DriverStatus, KycStatus, FleetDocumentStatus } from '@veo/shared-types';
import { PublishedTripState, PricingMode, type PublishedTrip } from '../generated/prisma';
import {
  publishedTripMachine,
  CANCELABLE_STATES,
  SEARCHABLE_STATES,
} from '../domain/published-trip-state';
import { assertTramosReferToValidStopovers, destinoOrden } from '../domain/trip-segments';
import { PAIS } from '../domain/cost-cap';
import {
  BACKGROUND_CHECK_CLEARED,
  VEHICLE_STATUS_OPERABLE,
  isDriverEligible,
} from '../domain/driver-eligibility';
import {
  toPublishedTripPublicView,
  type PublishedTripPublicView,
} from './published-trip-public-view';
import { BookingEventType } from '../events/booking-events';
import {
  PublishedTripsRepository,
  type CreatePublishedTripData,
  type UpdatePublishedTripData,
  type SearchPublishedTripsCriteria,
} from './published-trips.repository';
import {
  CostCapService,
  type PriceCapInput,
  type StopoverPunto,
  type TramoPrecio,
} from '../cost-cap/cost-cap.service';
import { IDENTITY_CLIENT, type IdentityClient, type IdentityDriver } from '../identity/identity-client.port';
import {
  IDENTITY_BATCH_CLIENT,
  type IdentityBatchClient,
  type PublicDriver,
} from '../identity/identity-batch-client.port';
import {
  FLEET_CLIENT,
  type FleetClient,
  type FleetVehicle,
  type PublicVehicle,
} from '../fleet/fleet-client.port';
import type { CreatePublishedTripDto } from './dto/create-published-trip.dto';
import type { UpdatePublishedTripDto } from './dto/update-published-trip.dto';
import type { ListMinePageDto } from './dto/list-mine-page.dto';
import type { SearchPublishedTripsDto } from './dto/search-published-trips.dto';

/**
 * Prefijo de la dedupKey de REQUEST (idempotencia del POST /published-trips, FIX 2). Aísla este espacio de
 * claves del resto. Constante TIPADA, cero strings mágicos sueltos: un único punto define el namespace.
 */
const REQUEST_DEDUP_NAMESPACE = 'published:req:' as const;

/** Default de paginación de GET /mine (FIX 5) si el cliente no pide `limit`. Acotado por @Max en el DTO. */
const DEFAULT_MINE_PAGE_SIZE = 20;

/**
 * País de publicación (F1a). HOY siempre PE (EC → F8). Constante TIPADA derivada de PAIS (cero strings
 * mágicos): la decide el tope de cost-sharing (costo/km por país) y se persiste en la oferta. Cuando EC
 * entre (F8), esto se derivará del contexto del conductor; por ahora es el único país soportado.
 */
const PUBLISH_COUNTRY = PAIS.PE;

/** Default de tamaño de página de la BÚSQUEDA (F2) si el cliente no pide `limit`. Acotado por @Max(50) en el DTO. */
const DEFAULT_SEARCH_PAGE_SIZE = 20;

/** Token DI de la config de la búsqueda H3 (k del anillo + k expandido), provista desde env por el módulo. */
export const SEARCH_H3_CONFIG = Symbol('SEARCH_H3_CONFIG');

/** Config TIPADA de la búsqueda geo H3 (F2): k base + k expandido si la primera pasada da CERO resultados. */
export interface SearchH3Config {
  /** k del anillo base (neighbors(celda, kRing)). Default env 1. */
  kRing: number;
  /** k del anillo EXPANDIDO: se reintenta con este k SOLO si la búsqueda base da 0 resultados. Default env 2. */
  kRingExpand: number;
}

/**
 * Resultado de la BÚSQUEDA (F2): la VISTA PÚBLICA del viaje (FIX 1 · sin dedupKey/driverId/vehicleId/H3) + el
 * conductor PÚBLICO enriquecido (name/rating). `driver` es NULLABLE: si identity no respondió (degradación
 * honesta), el viaje viaja sin enriquecer (driver null) — la búsqueda NO se cuelga por identity caída.
 */
export interface SearchResultItem {
  trip: PublishedTripPublicView;
  driver: PublicDriverDisplay | null;
}

/** Página de la búsqueda: los ítems + el cursor keyset OPACO para pedir la siguiente (null si no hay más). */
export interface SearchPage {
  items: SearchResultItem[];
  nextCursor: string | null;
}

/**
 * Conductor tal como lo VE el pasajero (display-only): id + nombre + rating. La elegibilidad (suspendido/KYC)
 * se evalúa server-side para FILTRAR y NUNCA viaja al cliente — solo estos tres campos salen por el wire.
 */
export interface PublicDriverDisplay {
  id: string;
  name: string;
  averageRating: number;
}

/**
 * Detalle ENRIQUECIDO de un viaje (GET /published-trips/:id, F2): la VISTA PÚBLICA del viaje (FIX 1 · sin
 * dedupKey/driverId/vehicleId/H3) + conductor PÚBLICO (name/rating) + vehículo PÚBLICO (modelo/placa/color).
 * `driver`/`vehicle` nullable: degradación honesta si identity/fleet no responden (el detalle igual se
 * devuelve, solo sin esa parte).
 */
export interface PublishedTripDetail {
  trip: PublishedTripPublicView;
  driver: PublicDriverDisplay | null;
  vehicle: PublicVehicle | null;
}

@Injectable()
export class PublishedTripsService {
  constructor(
    private readonly repo: PublishedTripsRepository,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityClient,
    @Inject(IDENTITY_BATCH_CLIENT) private readonly identityBatch: IdentityBatchClient,
    @Inject(FLEET_CLIENT) private readonly fleet: FleetClient,
    private readonly costCap: CostCapService,
    @Inject(SEARCH_H3_CONFIG) private readonly searchConfig: SearchH3Config,
  ) {}

  /**
   * Publica una oferta. `driverId` viene de la identidad firmada del conductor (server-truth, NO del body):
   * el dueño de la oferta es quien la publica — anti-IDOR por construcción.
   *
   * GATES F1a (antes de cualquier escritura):
   *  1. Elegibilidad del conductor (identity.GetDriver, fail-closed).
   *  2. Pertenencia + vigencia del vehículo (fleet.GetDriverVehicles, anti-IDOR + fail-closed).
   *
   * Estado inicial: la oferta se modela como BORRADOR y se PUBLICA en el mismo acto. La transición
   * BORRADOR→PUBLICADO se VALIDA por la máquina (assertTransition) antes de escribir.
   */
  async publish(
    driverId: string,
    dto: CreatePublishedTripDto,
    idempotencyKey?: string,
  ): Promise<PublishedTrip> {
    // Invariante de publicación (ADR-014 §4.1): asientosTotales > 0 (el DTO ya exige Min(1); se re-valida
    // server-side, defensa en profundidad) y pricingMode=FIJO (PUJA es F6, fuera de scope).
    if (dto.asientosTotales <= 0) {
      throw new ValidationError('asientosTotales debe ser mayor a 0', {
        asientosTotales: dto.asientosTotales,
      });
    }
    // Viaje PROGRAMADO: la salida debe ser en el futuro (charge-on-approval no tiene sentido en el pasado).
    const fechaHoraSalida = new Date(dto.fechaHoraSalida);
    if (Number.isNaN(fechaHoraSalida.getTime()) || fechaHoraSalida.getTime() <= Date.now()) {
      throw new ValidationError('fechaHoraSalida debe ser una fecha futura', {
        fechaHoraSalida: dto.fechaHoraSalida,
      });
    }

    // GATE 1 — elegibilidad del conductor (server-truth contra identity). Fail-closed.
    await this.assertDriverEligible(driverId);
    // GATE 2 — pertenencia + vigencia del vehículo (anti-IDOR contra el driverId server-truth). Fail-closed.
    await this.assertVehicleUsable(driverId, dto.vehicleId);

    // LA REGLA, NO EL IF: validar BORRADOR→PUBLICADO por la máquina tipada antes de cualquier escritura.
    publishedTripMachine.assertTransition(PublishedTripState.BORRADOR, PublishedTripState.PUBLICADO);

    // precioPorTramo OPCIONAL (F1a): si no llega (o llega vacío), el backend rellena el tramo full-route
    // [origen(0) → destino] con precioBase. El destino es un hito PROPIO tras el último stopover
    // (`destinoOrden()`, fuente única): max(stopovers.orden)+1; sin stopovers, orden 1 (origen=0 → destino=1).
    const precioPorTramo = this.resolvePrecioPorTramo(dto);

    // FIX 3 — INTEGRIDAD REFERENCIAL stopovers↔tramos: todo tramo debe referenciar hitos EXISTENTES en este
    // payload (origen=0 ∪ stopovers ∪ destino). Un tramo huérfano (apunta a un orden inexistente) → 400.
    // (Va ANTES del gate de precio: el tope necesita resolver cada tramo a hitos que existen.)
    assertTramosReferToValidStopovers(dto.stopovers ?? [], precioPorTramo);

    // GATE F1b — TOPE de cost-sharing por distancia (ADR-014 §8 · escudo legal anti-lucro). Server-side:
    // precioBase ≤ (distancia_full_km × costo/km) / asientos, e ídem por cada tramo. La distancia sale del
    // PUERTO de mapas (@veo/maps). FAIL-CLOSED igual que los gates F1a: si el motor de rutas no responde, NO
    // se publica (mejor bloquear que validar mal el tope legal). Va después de vehículo, antes de la transición.
    await this.costCap.assertPriceCap({
      pais: PUBLISH_COUNTRY,
      asientosTotales: dto.asientosTotales,
      precioBaseCentimos: dto.precioBase,
      // Peaje declarado por el conductor (default 0): sube SOLO el tope full-route (costo del viaje entero).
      tollsCents: dto.tollsCents ?? 0,
      origenLat: dto.origenLat,
      origenLon: dto.origenLon,
      destinoLat: dto.destinoLat,
      destinoLon: dto.destinoLon,
      stopovers: dto.stopovers ?? [],
      tramos: precioPorTramo,
    });

    const id = uuidv7();
    // FIX 2 — idempotencia de REQUEST anclada en el `Idempotency-Key` del cliente y NAMESPACEADA por el
    // `driverId` server-truth (anti-IDOR cross-tenant): reintento del MISMO submit del MISMO conductor →
    // misma dedupKey → P2002 → oferta existente; dos conductores con el MISMO header → dedupKeys distintas →
    // no colisionan. Sin header → key única server-side (no dedupea, no lockea), igual namespaceada.
    const dedupKey = this.deriveRequestDedupKey(driverId, idempotencyKey);
    // PREREQUISITO F2 (cierra el gap de F1a): poblar la celda índice H3 de origen y destino EN LA MISMA
    // transacción del create. Se calculan con @veo/utils (toH3 + DISPATCH_H3_RESOLUTION=9, ≈174m urbano
    // Lima) — fuente única, NUNCA otra lib H3 ni cálculo a mano. La búsqueda geo de F2 (GET /search) filtra
    // por estas celdas; sin poblarlas, la oferta nace invisible a la búsqueda. Nullable-safe en el schema
    // (filas legacy sin H3 simplemente no matchean la búsqueda), pero TODA oferta nueva los porta.
    const originH3 = toH3({ lat: dto.origenLat, lon: dto.origenLon }, DISPATCH_H3_RESOLUTION);
    const destH3 = toH3({ lat: dto.destinoLat, lon: dto.destinoLon }, DISPATCH_H3_RESOLUTION);
    const data: CreatePublishedTripData = {
      id,
      driverId,
      dedupKey,
      vehicleId: dto.vehicleId,
      origenLat: dto.origenLat,
      origenLon: dto.origenLon,
      originH3,
      destinoLat: dto.destinoLat,
      destinoLon: dto.destinoLon,
      destH3,
      stopovers: (dto.stopovers ?? []) as unknown as object,
      fechaHoraSalida,
      asientosTotales: dto.asientosTotales,
      // F0: nace con todos los asientos disponibles. Decrementa SOLO al CONFIRMAR un booking (§6, F3).
      asientosDisponibles: dto.asientosTotales,
      // pricingMode FIJO por decisión del ADR-014 (PUJA → F6). Se fija server-side, no se acepta del body.
      pricingMode: PricingMode.FIJO,
      precioBase: dto.precioBase,
      precioPorTramo,
      // Peaje del viaje (céntimos PEN, default 0). Persistido con la oferta; el cost-cap lo suma al tope.
      tollsCents: dto.tollsCents ?? 0,
      modoReserva: dto.modoReserva,
      reglas: dto.reglas ?? null,
      pais: PUBLISH_COUNTRY, // EC → F8
      moneda: 'PEN',
      estado: PublishedTripState.PUBLICADO,
    };

    return this.repo.createWithEventIdempotent(dedupKey, driverId, data, {
      eventType: BookingEventType.PUBLISHED,
      aggregateId: id,
      payload: {
        publishedTripId: id,
        driverId,
        vehicleId: dto.vehicleId,
        asientosTotales: dto.asientosTotales,
        precioBase: dto.precioBase,
        modoReserva: dto.modoReserva,
        fechaHoraSalida: fechaHoraSalida.toISOString(),
        pais: PUBLISH_COUNTRY,
        moneda: 'PEN',
      },
    });
  }

  /**
   * dedupKey de REQUEST del publish: namespaceada por el `driverId` server-truth Y por el `Idempotency-Key`
   * del cliente — `published:req:{driverId}:{idempotencyKey}`. El `driverId` va PRIMERO (es server-truth, lo
   * pone el backend): dos conductores DISTINTOS NUNCA derivan la misma dedupKey aunque manden el MISMO header
   * (anti-IDOR cross-tenant, lección de Booking F0 — JAMÁS derivar la key de otra cosa). Sin header: key
   * única server-side (uuidv7) igual namespaceada — no dedupea (cada submit es nuevo) ni lockea.
   */
  private deriveRequestDedupKey(driverId: string, idempotencyKey?: string): string {
    const tenantNamespace = `${REQUEST_DEDUP_NAMESPACE}${driverId}:`;
    if (idempotencyKey === undefined) {
      return `${tenantNamespace}${uuidv7()}`;
    }
    if (!isUuid(idempotencyKey)) {
      throw new ValidationError('Idempotency-Key debe ser un UUID', { idempotencyKey });
    }
    return `${tenantNamespace}${idempotencyKey}`;
  }

  /** Lee una oferta por id (sin enriquecer). 404 tipado si no existe. Lo usa el detalle enriquecido. */
  async getById(id: string): Promise<PublishedTrip> {
    const trip = await this.repo.findById(id);
    if (!trip) throw new NotFoundError('Viaje publicado no encontrado', { id });
    return trip;
  }

  /**
   * Detalle ENRIQUECIDO de un viaje (GET /published-trips/:id · public-rail ANÓNIMO, F2). Lee la oferta y la
   * enriquece con el conductor PÚBLICO (name/rating) + el vehículo PÚBLICO (modelo/placa/color) — SOLO campos
   * públicos (minimización H8), devueltos como VISTA PÚBLICA (FIX 1 · sin dedupKey/driverId/vehicleId/H3).
   *
   * FIX 4 — VISIBILIDAD: el detalle es la cara pública de una oferta RESERVABLE. Solo devuelve viajes en estado
   * SEARCHABLE (PUBLICADO/PARCIALMENTE_RESERVADO) Y con salida FUTURA (mismo criterio que la búsqueda). Un
   * viaje CANCELADO/LLENO/EN_RUTA/COMPLETADO o ya partido → NotFoundError (degradación honesta: no filtra
   * EXISTENCIA, simplemente no es ofertable — el anónimo no lee ofertas muertas).
   *
   * FIX 3 — ELEGIBILIDAD DEL CONDUCTOR: la elegibilidad del conductor se evalúa con el MISMO predicado que la
   * búsqueda (`isDriverEligible`). Si el conductor fue SUSPENDIDO / KYC-revocado DESPUÉS de publicar, su oferta
   * NO debe ofrecerse como reservable → NotFoundError (no la mostramos como disponible). La lectura de identity
   * es AUTORITATIVA acá (no best-effort): a diferencia del enriquecimiento de display, la elegibilidad es un
   * gate de seguridad — si identity no responde, FALLA-CERRADO (no ofrecemos un viaje que no podemos validar).
   * El vehículo SÍ es best-effort (degradación honesta: dato de display, no de seguridad).
   */
  async getDetail(id: string): Promise<PublishedTripDetail> {
    const trip = await this.getById(id);

    // FIX 4 — gate de visibilidad: estado searchable + salida futura. Si no, 404 (no es ofertable). Mismo
    // criterio que la búsqueda (SEARCHABLE_STATES + fechaHoraSalida > now), aplicado al detalle por id.
    if (
      !SEARCHABLE_STATES.includes(trip.estado) ||
      trip.fechaHoraSalida.getTime() <= Date.now()
    ) {
      throw new NotFoundError('Viaje publicado no encontrado', { id });
    }

    // FIX 3 — gate de elegibilidad del conductor (AUTORITATIVO, fail-closed): leemos identity y exigimos que el
    // conductor siga elegible. found=false / identity caída / no elegible → no ofrecemos el viaje (404).
    let eligibleDriver: PublicDriverDisplay;
    try {
      const d = await this.identity.getDriver(trip.driverId);
      // FIX 1·F2: predicado ÚNICO sobre TODOS los ejes (incl. antecedentes). `IdentityDriver` satisface
      // `DriverEligibilityView` completo, así que se pasa directo — imposible olvidar un eje (mismo criterio
      // que publish y search; un conductor con antecedentes no-cleared tampoco se ofrece en el detalle).
      if (!isDriverEligible(d)) {
        throw new NotFoundError('Viaje publicado no encontrado', { id });
      }
      eligibleDriver = { id: trip.driverId, name: d.name, averageRating: d.averageRating };
    } catch (err) {
      // Un NotFoundError (no elegible) se propaga tal cual; cualquier otro fallo (identity caída) → fail-closed
      // a 404: no ofrecemos como reservable un viaje cuya elegibilidad de conductor no pudimos verificar.
      if (err instanceof NotFoundError) throw err;
      throw new NotFoundError('Viaje publicado no encontrado', { id });
    }

    // Vehículo: BEST-EFFORT (dato de display, no de seguridad). Si fleet no responde → null, el detalle igual viaja.
    const vehicle = await this.fleet.getVehicle(trip.vehicleId).catch(() => null);

    return { trip: toPublishedTripPublicView(trip), driver: eligibleDriver, vehicle };
  }

  /**
   * BÚSQUEDA de viajes publicados por RUTA + fecha + asientos (GET /published-trips/search · public-rail
   * ANÓNIMO, F2 · §6.2). El pasajero NO necesita estar logueado: no se scopea a ningún usuario.
   *
   * Lógica:
   *  1. Celdas H3 (res 9) del origen y del destino buscados → sus ANILLOS (neighbors(celda, k)) con k=kRing.
   *  2. WHERE en el repo: `origin_h3 IN originRing AND dest_h3 IN destRing` (RUTA A→B → AND) + asientos +
   *     estado IN SEARCHABLE_STATES + salida dentro del DÍA pedido Y futura. Orden fechaHoraSalida ASC, keyset.
   *  3. EXPANSIÓN k: si k=kRing da CERO resultados (y kRingExpand > kRing y NO es una página de continuación),
   *     se reintenta UNA vez con k=kRingExpand (anillo más grande). Tunable por env.
   *  4. ENRIQUECIMIENTO ANTI-N+1: se juntan los driverId ÚNICOS de la página → UNA sola GetDriversByIds →
   *     se mapea cada viaje con su conductor público (name/rating). Si identity cae, degrada honesto (driver
   *     null) — la búsqueda NO se cuelga.
   *
   * DIFERIDO (degradación honesta, §6.2): el abordaje en STOPOVER (matchear una parada intermedia cercana al
   * origen/destino buscado, no solo los extremos exactos del viaje) queda como REFINAMIENTO FUTURO — hoy se
   * matchea origen↔origen y destino↔destino. NO se construye en F2.
   */
  async search(dto: SearchPublishedTripsDto): Promise<SearchPage> {
    // `dto.fecha` es una fecha-calendario PURA `YYYY-MM-DD` (el DTO rechaza datetime/offset, FIX 2·F2): así el
    // cliente NO puede manipular los componentes que `limaDayRange` toma. `new Date('YYYY-MM-DD')` = medianoche
    // UTC cuyos Y/M/D en UTC SON el día calendario pedido; `limaDayRange` le aplica la zona Lima (UTC-5).
    const fecha = new Date(dto.fecha);
    if (Number.isNaN(fecha.getTime())) {
      throw new ValidationError('fecha inválida', { fecha: dto.fecha });
    }
    const { desde, hasta } = limaDayRange(fecha);
    const take = dto.limit ?? DEFAULT_SEARCH_PAGE_SIZE;
    const cursor = decodeSearchCursor(dto.cursor);

    // Celdas índice de los EXTREMOS buscados (mismo @veo/utils que el publish → consistencia de celdas).
    const originCell = toH3({ lat: dto.originLat, lon: dto.originLon }, DISPATCH_H3_RESOLUTION);
    const destCell = toH3({ lat: dto.destLat, lon: dto.destLon }, DISPATCH_H3_RESOLUTION);

    const baseCriteria = {
      asientos: dto.asientos,
      estados: SEARCHABLE_STATES,
      desde,
      hasta,
      ahora: new Date(),
      take,
      ...(cursor ? { cursor } : {}),
    } satisfies Omit<SearchPublishedTripsCriteria, 'originRing' | 'destRing'>;

    // Pasada base (k = kRing).
    let trips = await this.repo.searchByRoute({
      ...baseCriteria,
      originRing: neighbors(originCell, this.searchConfig.kRing),
      destRing: neighbors(destCell, this.searchConfig.kRing),
    });

    // EXPANSIÓN: si la base dio CERO y el k expandido es MAYOR, reintentar UNA vez con el anillo más grande.
    // Solo en la PRIMERA página (sin cursor): expandir el anillo a mitad de paginación cambiaría el universo
    // de resultados y rompería la consistencia del keyset (mejor: la primera página decide el radio).
    if (
      trips.length === 0 &&
      cursor === undefined &&
      this.searchConfig.kRingExpand > this.searchConfig.kRing
    ) {
      trips = await this.repo.searchByRoute({
        ...baseCriteria,
        originRing: neighbors(originCell, this.searchConfig.kRingExpand),
        destRing: neighbors(destCell, this.searchConfig.kRingExpand),
      });
    }

    const items = await this.enrichWithDrivers(trips);
    // PAGINACIÓN POST-FILTRO (aceptado, BAJA · no bloquea): `enrichWithDrivers` puede DESCARTAR ítems de la
    // página (conductor no elegible / no resoluble). Por eso `items.length` puede ser MENOR que `trips.length`
    // (y que `take`): una página puede venir con menos resultados tras el filtro de elegibilidad. Es aceptable
    // —el keyset avanza igual por `trips` (la última fila CRUDA), así no se saltan ni repiten filas entre páginas—.
    // nextCursor: si la página CRUDA vino LLENA (== take), probablemente hay más → codificá la última fila CRUDA.
    // Si vino corta, no hay más (null). Keyset opaco (fechaHoraSalida, id) de la última fila en el orden ASC.
    const last = trips.length === take ? trips[trips.length - 1] : undefined;
    const nextCursor = last ? encodeSearchCursor(last.fechaHoraSalida, last.id) : null;

    return { items, nextCursor };
  }

  /**
   * Enriquecimiento ANTI-N+1 (F2): para N viajes, UNA sola llamada batch GetDriversByIds con los driverId
   * ÚNICOS — NUNCA N llamadas GetDriver. El gate `n-plus-one` debe dar CERO sobre este camino.
   *
   * FIX 3 — FILTRO DE ELEGIBILIDAD: el reply batch trae los ejes de elegibilidad (currentStatus/suspendedAt/
   * kycStatus/backgroundCheckStatus/found). Una oferta cuyo conductor fue SUSPENDIDO / KYC-revocado / antecedentes-
   * revocados DESPUÉS de publicar NO se muestra (el gate de publish es one-shot). Se usa el MISMO predicado ÚNICO
   * `isDriverEligible` que el detalle y el publish (fuente única): conductor en el batch y NO elegible → su oferta
   * se DESCARTA de la página.
   *
   * FIX 3·F2 — FAIL-CLOSED (seguridad > disponibilidad, CONSISTENTE con el detalle): si el batch FALLA (identity
   * caída) NO podemos verificar la elegibilidad de NINGÚN conductor de la página → NO incluimos viajes no-verificables.
   * Antes esto era fail-OPEN (los viajes viajaban con driver null), lo que dejaba pasar un conductor potencialmente
   * suspendido. El TRADE-OFF es deliberado: ante identity caída la búsqueda devuelve VACÍO (mejor no mostrar que
   * mostrar un viaje no-verificable) — el MISMO criterio que el detalle, que es fail-closed (404). Un conductor
   * presente en el reply pero NO elegible, o AUSENTE del reply (no resoluble), también se descarta.
   *
   * Mapea cada viaje superviviente a su VISTA PÚBLICA (FIX 1 · sin dedupKey/driverId/vehicleId/H3).
   */
  private async enrichWithDrivers(trips: PublishedTrip[]): Promise<SearchResultItem[]> {
    if (trips.length === 0) return [];

    const uniqueDriverIds = [...new Set(trips.map((t) => t.driverId))];
    let byId: Map<string, PublicDriver>;
    try {
      // UNA llamada para TODOS los conductores de la página (anti-N+1).
      const drivers = await this.identityBatch.getDriversByIds(uniqueDriverIds);
      byId = new Map(drivers.map((d) => [d.id, d]));
    } catch {
      // FAIL-CLOSED (FIX 3·F2): identity caída → no podemos verificar elegibilidad → NO mostramos viajes
      // no-verificables. La página devuelve vacío (mismo criterio de seguridad que el detalle). Mejor una
      // búsqueda vacía que una oferta de un conductor que pudo haber sido suspendido y no pudimos chequear.
      return [];
    }

    return trips.flatMap((trip) => {
      const driver = byId.get(trip.driverId) ?? null;
      // Conductor ausente del reply (no resoluble) o NO elegible (predicado ÚNICO, todos los ejes) → se DESCARTA.
      if (driver === null || !isDriverEligible(driver)) {
        return [];
      }
      const view: SearchResultItem = {
        trip: toPublishedTripPublicView(trip),
        driver: { id: driver.id, name: driver.name, averageRating: driver.averageRating },
      };
      return [view];
    });
  }

  /**
   * Lista las ofertas del conductor (GET /published-trips/mine). SCOPED por driverId server-truth — nunca
   * por un valor del cliente (anti-IDOR por construcción: no hay forma de pedir las de otro conductor).
   *
   * FIX 5 — PAGINADO: nunca devuelve todo el set de una. `limit` (acotado por @Max en el DTO) define el
   * tamaño de página; default DEFAULT_MINE_PAGE_SIZE si no llega. `cursor` (id de la última oferta de la
   * página previa) avanza por keyset. Un conductor con 500 ofertas pagina, no vuelca la tabla.
   */
  listMine(driverId: string, page: ListMinePageDto = {}): Promise<PublishedTrip[]> {
    const take = page.limit ?? DEFAULT_MINE_PAGE_SIZE;
    return this.repo.findByDriverId(driverId, take, page.cursor);
  }

  /**
   * Edita una oferta (PATCH /published-trips/:id). SOLO el dueño (driverId server-truth === trip.driverId);
   * si no, NotFoundError (no filtra existencia, anti-IDOR). SOLO editable mientras está PUBLICADO (sin
   * reservas confirmadas / pre-EN_RUTA): PARCIALMENTE_RESERVADO/LLENO ya tienen confirmadas, EN_RUTA/
   * COMPLETADO/CANCELADO son operativos/terminales → ValidationError. Emite booking.updated por outbox.
   */
  async update(
    id: string,
    driverId: string,
    dto: UpdatePublishedTripDto,
  ): Promise<PublishedTrip> {
    // Ownership server-truth: leo la oferta DESDE EL PRIMARY (FIX 1) y verifico que sea de ESTE conductor.
    // Miss → 404 (no revela que existe pero es de otro: mismo patrón anti-IDOR que getById de F0). El read
    // va al PRIMARY porque la réplica puede dar un estado stale; aun así, la GARANTÍA real contra TOCTOU la
    // da el WHERE condicionado del UPDATE (abajo), no este read — este es para el 404 y mensajes tempranos.
    const trip = await this.repo.findByIdFromPrimary(id);
    if (trip?.driverId !== driverId) {
      throw new NotFoundError('Viaje publicado no encontrado', { id });
    }

    // Editable SOLO en PUBLICADO. El resto de estados o tiene reservas confirmadas (PARCIALMENTE_RESERVADO/
    // LLENO) o ya está en ruta / es terminal — editar el itinerario/precio ahí rompería contratos con
    // pasajeros. La regla es del ESTADO, no un campo: se chequea contra el enum tipado, sin string mágico.
    // (Chequeo TEMPRANO para un 400 claro; la atomicidad la sella el where `estado: PUBLICADO` del UPDATE.)
    if (trip.estado !== PublishedTripState.PUBLICADO) {
      throw new ValidationError(
        'La oferta solo es editable mientras está PUBLICADO (sin reservas confirmadas ni en ruta)',
        { id, estado: trip.estado },
      );
    }

    // Re-validación temporal fina si se edita la fecha (sigue siendo viaje PROGRAMADO → futuro).
    let fechaHoraSalida: Date | undefined;
    if (dto.fechaHoraSalida !== undefined) {
      fechaHoraSalida = new Date(dto.fechaHoraSalida);
      if (Number.isNaN(fechaHoraSalida.getTime()) || fechaHoraSalida.getTime() <= Date.now()) {
        throw new ValidationError('fechaHoraSalida debe ser una fecha futura', {
          fechaHoraSalida: dto.fechaHoraSalida,
        });
      }
    }

    // FIX 3 — INTEGRIDAD REFERENCIAL stopovers↔tramos sobre el ESTADO FINAL: si se editan stopovers y/o
    // precioPorTramo (aun por separado), los tramos finales deben referenciar hitos que EXISTEN en los
    // stopovers finales. Resuelvo el set final tomando lo del DTO si llega, o lo persistido si no — así un
    // PATCH que cambia SOLO los stopovers no puede dejar tramos viejos huérfanos (ni viceversa).
    if (dto.stopovers !== undefined || dto.precioPorTramo !== undefined) {
      const stopoversFinal =
        dto.stopovers ?? readStopovers(trip.stopovers);
      const tramosFinal =
        dto.precioPorTramo ?? readTramos(trip.precioPorTramo);
      assertTramosReferToValidStopovers(stopoversFinal, tramosFinal);
    }

    // Patch parcial: solo los campos presentes en el DTO. asientosTotales no puede caer por debajo de los
    // ya reservados — en PUBLICADO no hay confirmadas (asientosDisponibles == asientosTotales), así que el
    // ajuste es seguro: sincronizo asientosDisponibles con el nuevo total.
    const data: UpdatePublishedTripData = {};
    if (dto.origenLat !== undefined) data.origenLat = dto.origenLat;
    if (dto.origenLon !== undefined) data.origenLon = dto.origenLon;
    if (dto.destinoLat !== undefined) data.destinoLat = dto.destinoLat;
    if (dto.destinoLon !== undefined) data.destinoLon = dto.destinoLon;
    // F2 — si el PATCH mueve el origen y/o el destino, RECALCULAR su celda índice H3 (mismo @veo/utils que
    // el publish): el estado final = DTO ∪ persistido. Sin esto, editar la ruta dejaría la celda H3 vieja y
    // la búsqueda geo encontraría la oferta en la ubicación equivocada (o la perdería). Solo se toca el H3
    // del extremo que cambió.
    if (dto.origenLat !== undefined || dto.origenLon !== undefined) {
      data.originH3 = toH3(
        { lat: dto.origenLat ?? trip.origenLat, lon: dto.origenLon ?? trip.origenLon },
        DISPATCH_H3_RESOLUTION,
      );
    }
    if (dto.destinoLat !== undefined || dto.destinoLon !== undefined) {
      data.destH3 = toH3(
        { lat: dto.destinoLat ?? trip.destinoLat, lon: dto.destinoLon ?? trip.destinoLon },
        DISPATCH_H3_RESOLUTION,
      );
    }
    if (dto.stopovers !== undefined) data.stopovers = dto.stopovers as unknown as object;
    if (fechaHoraSalida !== undefined) data.fechaHoraSalida = fechaHoraSalida;
    if (dto.asientosTotales !== undefined) {
      data.asientosTotales = dto.asientosTotales;
      data.asientosDisponibles = dto.asientosTotales; // PUBLICADO: 0 confirmadas → disponibles == totales.
    }
    if (dto.precioBase !== undefined) data.precioBase = dto.precioBase;
    if (dto.precioPorTramo !== undefined) {
      data.precioPorTramo = dto.precioPorTramo as unknown as object;
    }
    if (dto.tollsCents !== undefined) data.tollsCents = dto.tollsCents;
    if (dto.modoReserva !== undefined) data.modoReserva = dto.modoReserva;
    if (dto.reglas !== undefined) data.reglas = dto.reglas;

    // FIX 4 — NO-OP IDEMPOTENTE: si tras filtrar el patch NO hay ningún campo a actualizar (PATCH con body
    // vacío, o sólo con campos que no mutan nada), NO escribimos ni emitimos `booking.updated` (evento
    // espurio). Devolvemos el recurso ACTUAL (ya leído del PRIMARY, en PUBLICADO) tal cual — semántica
    // idempotente: un PATCH vacío es un no-op observable, no una mutación.
    if (Object.keys(data).length === 0) {
      return trip;
    }

    // GATE F1b en EDIT — RE-VALIDAR el tope contra el ESTADO FINAL (ruta + precio resultante). Solo si el
    // patch toca algo que mueve el tope: precioBase, precioPorTramo, origen/destino o stopovers. Si nada de
    // eso cambia (p.ej. solo reglas/modoReserva/fecha), la ruta y los precios son los ya validados al
    // publicar → no hace falta re-pegarle a mapas. El estado final = DTO ∪ persistido (mismo merge que FIX 3).
    if (this.editTouchesPriceCap(dto)) {
      await this.costCap.assertPriceCap(this.buildEditCapInput(trip, dto));
    }

    // FIX 1 — UPDATE ATÓMICO: solo aplica si la PRIMARIA sigue en PUBLICADO (no salió a EN_RUTA / con
    // reservas confirmadas entre el read y el write). 0 filas → P2025 → ConflictError (no 500). Cerrá TOCTOU.
    return this.repo.updateWithEvent(id, driverId, [PublishedTripState.PUBLICADO], data, {
      eventType: BookingEventType.UPDATED,
      aggregateId: id,
      payload: {
        publishedTripId: id,
        driverId,
        ...(dto.origenLat !== undefined && { origenLat: dto.origenLat }),
        ...(dto.origenLon !== undefined && { origenLon: dto.origenLon }),
        ...(dto.destinoLat !== undefined && { destinoLat: dto.destinoLat }),
        ...(dto.destinoLon !== undefined && { destinoLon: dto.destinoLon }),
        ...(dto.asientosTotales !== undefined && { asientosTotales: dto.asientosTotales }),
        ...(dto.precioBase !== undefined && { precioBase: dto.precioBase }),
        ...(dto.modoReserva !== undefined && { modoReserva: dto.modoReserva }),
        ...(fechaHoraSalida !== undefined && { fechaHoraSalida: fechaHoraSalida.toISOString() }),
        ...(dto.reglas !== undefined && { reglas: dto.reglas }),
      },
    });
  }

  /**
   * Cancela una oferta (POST /published-trips/:id/cancel). SOLO el dueño (server-truth); miss → 404
   * (anti-IDOR, no filtra existencia). Transición a CANCELADO vía la máquina tipada (assertTransition):
   * alcanzable desde cualquier estado PRE-EN_RUTA; EN_RUTA/COMPLETADO/CANCELADO → la máquina rechaza.
   * Emite booking.cancelled por outbox.
   */
  async cancel(id: string, driverId: string): Promise<PublishedTrip> {
    // Read crítico DESDE EL PRIMARY (FIX 1): la réplica puede dar un estado stale → un mensaje temprano
    // equivocado. La garantía contra TOCTOU la sella el where condicionado del UPDATE (CANCELABLE_STATES).
    const trip = await this.repo.findByIdFromPrimary(id);
    if (trip?.driverId !== driverId) {
      throw new NotFoundError('Viaje publicado no encontrado', { id });
    }

    // LA REGLA, NO EL IF: la máquina decide si CANCELADO es alcanzable desde el estado actual (lanza
    // si es EN_RUTA/terminal). CERO strings mágicos: se compara contra el enum tipado. (Validación TEMPRANA
    // para un 409 claro; la atomicidad la sella el where `estado: { in: CANCELABLE_STATES }` del UPDATE.)
    publishedTripMachine.assertTransition(trip.estado, PublishedTripState.CANCELADO);

    // FIX 1 — UPDATE ATÓMICO CONDICIONADO: solo cancela si la PRIMARIA sigue en un estado CANCELABLE (derivado
    // de la máquina, no strings sueltos). Si entre el read y el write pasó a EN_RUTA/terminal → 0 filas →
    // P2025 → ConflictError (no 500, no doble-evento). Re-cancelar una ya CANCELADA: CANCELADO no está en
    // CANCELABLE_STATES → 0 filas → ConflictError, sin emitir un segundo booking.cancelled (idempotente-seguro).
    // TODO F3: fan-out Refund a reservas activas (payment-service procesa el Refund por evento).
    return this.repo.updateWithEvent(
      id,
      driverId,
      CANCELABLE_STATES,
      { estado: PublishedTripState.CANCELADO },
      {
        eventType: BookingEventType.CANCELLED,
        aggregateId: id,
        payload: {
          publishedTripId: id,
          driverId,
          estado: PublishedTripState.CANCELADO,
          estadoAnterior: trip.estado,
        },
      },
    );
  }

  // ── Gates F1a (privados) ───────────────────────────────────────────────────────────────────────

  /**
   * Gate de elegibilidad del conductor en PUBLISH (ADR-014 §4.1/§8). Re-valida contra identity (server-truth)
   * ANTES de publicar. FALLA-CERRADO: si identity no responde, la llamada lanza y acá se traduce a ForbiddenError
   * (nunca un conductor no elegible colándose por un error de red — espeja dispatch).
   *
   * FIX 1·F2 — UNA SOLA FUENTE DE VERDAD: la DECISIÓN booleana sale de `isDriverEligible()` (el MISMO predicado
   * que usan search y detail), NO de una lista de condiciones propia que podría divergir. Si el predicado dice
   * false, este gate desglosa la PRIMERA causa SOLO para dar un mensaje claro — pero el criterio de corte es
   * idéntico por construcción: publish, search y detail no pueden divergir porque comparten el predicado.
   */
  private async assertDriverEligible(driverId: string): Promise<void> {
    let driver: IdentityDriver;
    try {
      driver = await this.identity.getDriver(driverId);
    } catch (err) {
      // fail-closed: identity caída / timeout (deadlineMs) → no se permite publicar.
      throw new ForbiddenError('No se pudo verificar la elegibilidad del conductor (identity no disponible)', {
        driverId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    // DECISIÓN: la toma el predicado ÚNICO (todos los ejes, incl. antecedentes). Si pasa, no hay nada que reportar.
    if (isDriverEligible(driver)) return;
    // No elegible: desglosamos la PRIMERA causa para un 403 con mensaje claro (mismo ORDEN que el predicado).
    if (!driver.found) {
      throw new ForbiddenError('Conductor no encontrado para publicar', { driverId });
    }
    if (driver.suspendedAt !== null) {
      throw new ForbiddenError('Conductor suspendido: no puede publicar viajes', {
        driverId,
        suspendedAt: driver.suspendedAt,
      });
    }
    if (driver.currentStatus === DriverStatus.SUSPENDED) {
      throw new ForbiddenError('Conductor suspendido: no puede publicar viajes', {
        driverId,
        currentStatus: driver.currentStatus,
      });
    }
    if (driver.kycStatus !== KycStatus.VERIFIED) {
      throw new ForbiddenError('KYC del conductor no verificado: no puede publicar viajes', {
        driverId,
        kycStatus: driver.kycStatus,
      });
    }
    // Única causa restante (el predicado dio false y las anteriores pasaron): antecedentes no CLEARED.
    throw new ForbiddenError('Antecedentes del conductor no aprobados: no puede publicar viajes', {
      driverId,
      backgroundCheckStatus: driver.backgroundCheckStatus,
    });
  }

  /**
   * Validación ANTI-IDOR + vigencia del vehículo (ADR-014 §8 · familia de bug crítica). El vehicleId lo
   * elige el cliente, pero la PERTENENCIA se valida server-side contra el conductor SERVER-TRUTH: se pide
   * la lista de SUS vehículos y se exige que el vehicleId esté entre ellos. Si no → ForbiddenError (un
   * conductor intentando publicar con un vehículo ajeno). FALLA-CERRADO si fleet no responde.
   *
   * Vehículo propio pero NO vigente (inactivo / status no operable / docs no VALID) → ValidationError con
   * la causa (no es un ataque, es un estado inválido del recurso propio).
   */
  private async assertVehicleUsable(driverId: string, vehicleId: string): Promise<void> {
    let vehicles: FleetVehicle[];
    try {
      vehicles = await this.fleet.getDriverVehicles(driverId);
    } catch (err) {
      // fail-closed: fleet caída / timeout → no se publica sin validar el vehículo.
      throw new ForbiddenError('No se pudo verificar el vehículo del conductor (fleet no disponible)', {
        driverId,
        vehicleId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    // ANTI-IDOR: la PERTENENCIA se valida contra el driverId server-truth, no contra el valor del cliente.
    const vehicle = vehicles.find((v) => v.id === vehicleId);
    if (!vehicle) {
      throw new ForbiddenError('El vehículo no pertenece al conductor (no puede publicar con un vehículo ajeno)', {
        driverId,
        vehicleId,
      });
    }

    // Vigencia: el vehículo propio debe estar activo + status operable + docs VALID (defensa en profundidad).
    if (!vehicle.active) {
      throw new ValidationError('El vehículo no está activo', { vehicleId });
    }
    if (vehicle.status !== VEHICLE_STATUS_OPERABLE) {
      throw new ValidationError('El vehículo no está operable (revisión pendiente)', {
        vehicleId,
        status: vehicle.status,
      });
    }
    if (vehicle.docStatus !== FleetDocumentStatus.VALID) {
      throw new ValidationError('Los documentos del vehículo no están vigentes', {
        vehicleId,
        docStatus: vehicle.docStatus,
      });
    }
  }

  /**
   * Resuelve precioPorTramo (F1a): respeta lo que llega; si viene ausente o vacío, rellena el tramo
   * full-route [origen(0) → destino] con precioBase. El orden del destino lo decide `destinoOrden()` del
   * dominio (FUENTE ÚNICA del modelo de hitos): max(stopovers.orden)+1; sin stopovers, orden 1. Compartir
   * esta función con la validación garantiza que el tramo default NUNCA es huérfano (cero drift de modelo).
   */
  private resolvePrecioPorTramo(
    dto: CreatePublishedTripDto,
  ): { desdeOrden: number; hastaOrden: number; precioCentimos: number }[] {
    if (dto.precioPorTramo && dto.precioPorTramo.length > 0) {
      return dto.precioPorTramo.map((t) => ({
        desdeOrden: t.desdeOrden,
        hastaOrden: t.hastaOrden,
        precioCentimos: t.precioCentimos,
      }));
    }
    const hastaOrden = destinoOrden(dto.stopovers ?? []);
    return [{ desdeOrden: 0, hastaOrden, precioCentimos: dto.precioBase }];
  }

  /**
   * ¿El PATCH toca un campo que mueve el tope de cost-sharing? Re-valida ante TODO input de la fórmula del
   * tope (`capCentsForDistance`: `floor((distanciaKm × costo/km) / asientosTotales)`):
   *  - DISTANCIA → origen/destino/stopovers (los hitos de la ruta).
   *  - PRECIO comparado → precioBase (full-route) + precioPorTramo.
   *  - DIVISOR → asientosTotales: MÁS asientos = tope MENOR; subir asientos puede dejar el precio sobre el
   *    tope nuevo SIN re-validar (BYPASS F1b corregido) → DEBE disparar la re-validación.
   *  - PAÍS (costo/km) → NO es editable (UpdatePublishedTripDto no expone `pais`; queda fijo desde el publish),
   *    por eso no aparece acá. Si algún día `pais` se vuelve editable, AGREGARLO a esta lista (mueve el tope).
   * Si nada de esto cambia (solo reglas/modoReserva/fecha), la ruta + precios siguen siendo los validados al
   * publicar → no re-pegamos a mapas (evita una llamada de red innecesaria).
   */
  private editTouchesPriceCap(dto: UpdatePublishedTripDto): boolean {
    return (
      dto.precioBase !== undefined ||
      dto.precioPorTramo !== undefined ||
      // El peaje SUBE el tope full-route: editarlo cambia el tope → DEBE re-validar (anti inflado de peaje).
      dto.tollsCents !== undefined ||
      dto.origenLat !== undefined ||
      dto.origenLon !== undefined ||
      dto.destinoLat !== undefined ||
      dto.destinoLon !== undefined ||
      dto.stopovers !== undefined ||
      dto.asientosTotales !== undefined
    );
  }

  /**
   * Arma el input del gate F1b para el EDIT: el ESTADO FINAL = lo del DTO si llega, o lo PERSISTIDO si no
   * (mismo merge que la integridad referencial FIX 3). El nuevo precioBase también rellena el tramo
   * full-route default si el conductor NO mandó tramos pero sí editó precioBase/itinerario — así el tope se
   * valida sobre lo que realmente quedará persistido. Stopovers y tramos se NARROWAN del JSON con su forma full.
   *
   * TOCTOU del tope (FIX 3): el `trip` que entra acá es la lectura desde PRIMARY (`findByIdFromPrimary` del
   * inicio de `update`), NO la réplica. Es deliberado e INVARIANTE: el tope se valida contra los valores
   * persistidos REALES que se mergean con el DTO (una réplica stale podría dar un asientosTotales/precio/ruta
   * viejos y validar el tope contra un estado que ya no es el de la primaria). El UPDATE atómico de F1a sella
   * la escritura por estado; este merge sella que el INPUT del cálculo del tope sea consistente con la primaria.
   */
  private buildEditCapInput(trip: PublishedTrip, dto: UpdatePublishedTripDto): PriceCapInput {
    // Estado FINAL: el valor del DTO (numéricos planos) si llega, o el persistido. NO se lee de `data` —
    // ahí los campos son tipos Prisma de update (number | IntFieldUpdateOperationsInput), no plain numbers.
    const origenLat = dto.origenLat ?? trip.origenLat;
    const origenLon = dto.origenLon ?? trip.origenLon;
    const destinoLat = dto.destinoLat ?? trip.destinoLat;
    const destinoLon = dto.destinoLon ?? trip.destinoLon;
    const asientosTotales = dto.asientosTotales ?? trip.asientosTotales;
    const precioBase = dto.precioBase ?? trip.precioBase;
    // Peaje FINAL: el del DTO si llega, o el persistido (mismo merge DTO ∪ persistido que el resto del input).
    const tollsCents = dto.tollsCents ?? trip.tollsCents;

    const stopovers: StopoverPunto[] = dto.stopovers ?? readStopoverPuntos(trip.stopovers);

    // Tramos finales: los del DTO si llegan; si no, los persistidos. Si el resultado queda vacío (oferta sin
    // tramos explícitos), se valida el tramo full-route default con el precioBase final (espeja resolvePrecioPorTramo).
    let tramos: TramoPrecio[] = dto.precioPorTramo ?? readTramoPrecios(trip.precioPorTramo);
    if (tramos.length === 0) {
      tramos = [{ desdeOrden: 0, hastaOrden: destinoOrden(stopovers), precioCentimos: precioBase }];
    }

    return {
      pais: trip.pais,
      asientosTotales,
      precioBaseCentimos: precioBase,
      tollsCents,
      origenLat,
      origenLon,
      destinoLat,
      destinoLon,
      stopovers,
      tramos,
    };
  }
}

/**
 * Narrowing TIPADO del `stopovers` JSON persistido (Prisma.JsonValue) al shape mínimo que la validación de
 * integridad necesita (`{ orden }[]`). Tolerante a filas legacy: descarta entradas que no traen `orden`
 * numérico (no rompe la validación con datos sucios; el invariante se evalúa sobre lo bien formado).
 */
function readStopovers(value: unknown): { orden: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.orden === 'number' ? [{ orden: entry.orden }] : [],
  );
}

/**
 * Narrowing TIPADO del `precioPorTramo` JSON persistido al shape `{ desdeOrden, hastaOrden }[]` que la
 * validación necesita. Descarta entradas mal formadas (mismo criterio tolerante que readStopovers).
 */
function readTramos(value: unknown): { desdeOrden: number; hastaOrden: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.desdeOrden === 'number' &&
    typeof entry.hastaOrden === 'number'
      ? [{ desdeOrden: entry.desdeOrden, hastaOrden: entry.hastaOrden }]
      : [],
  );
}

/**
 * Narrowing TIPADO del `stopovers` JSON persistido al shape COMPLETO `{ lat, lon, orden }[]` que el gate de
 * precio F1b necesita (requiere las coordenadas, no solo el orden). Descarta entradas mal formadas (mismo
 * criterio tolerante). Distinto de `readStopovers` (que solo extrae `orden` para la integridad referencial).
 */
function readStopoverPuntos(value: unknown): StopoverPunto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.lat === 'number' &&
    typeof entry.lon === 'number' &&
    typeof entry.orden === 'number'
      ? [{ lat: entry.lat, lon: entry.lon, orden: entry.orden }]
      : [],
  );
}

/**
 * Narrowing TIPADO del `precioPorTramo` JSON persistido al shape COMPLETO `{ desdeOrden, hastaOrden,
 * precioCentimos }[]` que el gate F1b necesita (requiere el precio del tramo, no solo sus órdenes). Descarta
 * entradas mal formadas. Distinto de `readTramos` (que solo extrae los órdenes para la integridad referencial).
 */
function readTramoPrecios(value: unknown): TramoPrecio[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.desdeOrden === 'number' &&
    typeof entry.hastaOrden === 'number' &&
    typeof entry.precioCentimos === 'number'
      ? [{ desdeOrden: entry.desdeOrden, hastaOrden: entry.hastaOrden, precioCentimos: entry.precioCentimos }]
      : [],
  );
}

/** Type-guard mínimo: ¿`value` es un objeto plano indexable? (evita `any`, narrowing seguro del JSON). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Offset fijo de la zona horaria de VEO (America/Lima) respecto a UTC, en MINUTOS. -300 = UTC-5. Perú NO
 * observa horario de verano (DST) desde 1994 — el offset es CONSTANTE, así que NO se necesita una lib de TZ:
 * basta desplazar el reloj de pared ±5h. Ecuador (F8) comparte UTC-5, así que esta constante sirve a ambos.
 * Constante TIPADA (cero strings/números mágicos sueltos): un único punto define la zona de negocio. Espeja
 * `LIMA_UTC_OFFSET_MINUTES` de trip-service (mismo valor; cada servicio lo declara local, no se cruzan tablas).
 */
const VEO_TIMEZONE_OFFSET_MINUTES = -300 as const;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Rango [desde, hasta) del DÍA en HORA PERÚ (UTC-5) para el filtro de la búsqueda (F2 · FIX 2): la salida del
 * viaje debe caer en el día pedido SEGÚN EL CALENDARIO LIMA, no UTC. Antes el rango se armaba en UTC → cerca
 * de medianoche un viaje del día pedido caía fuera (o entraba uno del día equivocado): un viaje a las 23:00
 * hora Lima del día X es 04:00 UTC del día X+1, así que el rango UTC del día X lo perdía.
 *
 * El cliente manda `fecha` como ISO date (ej. "2030-03-15") = el DÍA CALENDARIO Lima que el pasajero eligió.
 * `new Date("2030-03-15")` es medianoche UTC, cuyo Y/M/D en UTC ES el día calendario pedido (15). Tomamos ESOS
 * componentes calendario y construimos la ventana en hora Lima: `desde` = 00:00 de ese día -05:00 (= 05:00 UTC),
 * `hasta` = +24h (exclusive). NO se desplaza la fecha antes de truncar (eso movería "2030-03-15" a "2030-03-14"
 * Lima): el día pedido se respeta tal cual y se le aplica el offset. Sin lib de TZ (Perú no tiene DST). El
 * filtro `> now()` del repo recorta además los viajes del día pero ya partidos.
 */
function limaDayRange(fecha: Date): { desde: Date; hasta: Date } {
  // 00:00 del día calendario pedido como reloj de pared, en ms UTC (componentes UTC del ISO date = ese día).
  const midnightWall = Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate());
  // De pared Lima → UTC: 00:00 Lima = ese instante de pared MENOS el offset (restar -300min = +5h → 05:00 UTC).
  const desde = new Date(midnightWall - VEO_TIMEZONE_OFFSET_MINUTES * MINUTE_MS);
  const hasta = new Date(desde.getTime() + DAY_MS); // +1 día (exclusive)
  return { desde, hasta };
}

/** Separador del cursor keyset de búsqueda. `|` no aparece en un ISO-8601 ni en un UUID → parseo sin ambigüedad. */
const SEARCH_CURSOR_SEP = '|';

/**
 * Codifica el cursor keyset OPACO de la búsqueda: base64 de `${fechaHoraSalidaISO}|${id}` de la última fila
 * de la página. Opaco = el cliente lo trata como token, no lo construye a mano.
 */
function encodeSearchCursor(fechaHoraSalida: Date, id: string): string {
  return Buffer.from(`${fechaHoraSalida.toISOString()}${SEARCH_CURSOR_SEP}${id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decodifica el cursor keyset de la búsqueda. TOLERANTE: un cursor ausente → undefined (primera página); un
 * cursor mal formado (no decodifica, fecha inválida, sin id) → undefined también (degrada a primera página
 * en vez de 500 por un token corrupto del cliente). Devuelve la tupla (fechaHoraSalida, id) del keyset.
 */
function decodeSearchCursor(
  cursor: string | undefined,
): { fechaHoraSalida: Date; id: string } | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const sep = decoded.indexOf(SEARCH_CURSOR_SEP);
  if (sep < 0) return undefined;
  const iso = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  const fechaHoraSalida = new Date(iso);
  if (id === '' || Number.isNaN(fechaHoraSalida.getTime())) return undefined;
  return { fechaHoraSalida, id };
}
