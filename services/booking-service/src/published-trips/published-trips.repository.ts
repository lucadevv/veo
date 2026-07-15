/**
 * PublishedTripsRepository — acceso Prisma al agregado PublishedTrip (schema 'booking'). Encapsula el
 * patrón OUTBOX-EN-TRANSACCIÓN: la creación/edición de la oferta y el INSERT del evento van en la MISMA
 * transacción Prisma (atomicidad estado↔evento, FOUNDATION §6 / ADR-014 §7).
 *
 * F1 — endurecimiento del write path:
 *  - IDEMPOTENCIA DE PUBLISH (`createWithEventIdempotent`): un doble-POST con el mismo Idempotency-Key
 *    (→ misma `dedupKey`, namespaceada por driverId) NO duplica oferta+evento. Ante P2002 en `dedupKey` se
 *    recupera la fila del PRIMARY y se RE-VERIFICA ownership antes de devolverla (anti-IDOR cross-tenant,
 *    misma lección que Booking F0).
 *  - UPDATE ATÓMICO CONDICIONADO POR ESTADO (`updateWithEvent`): el `where` incluye `estado: { in: allowed }`
 *    además de `{ id, driverId }`. El write SOLO aplica si el estado en la PRIMARIA sigue siendo válido →
 *    cierra la ventana TOCTOU (la decisión se valida en el WRITE, no en un read stale de la réplica). Si 0
 *    filas matchean (Prisma lanza P2025) → ConflictError tipado ("el viaje cambió de estado, recargá"),
 *    NUNCA un 500 ni el mensaje interno de Prisma.
 */
import { Injectable } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { isUniqueViolation, isRecordNotFound } from '@veo/database';
import { ConflictError, type GeoBBox } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, PublishedTripState, type PublishedTrip } from '../generated/prisma';
import { BOOKING_PRODUCER, type BookingEventType } from '../events/booking-events';
import type { SearchOrder } from './dto/search-published-trips.dto';

/** Datos ya validados/derivados por el service para materializar la fila PublishedTrip. */
export type CreatePublishedTripData = Prisma.PublishedTripUncheckedCreateInput;

/** Patch ya validado/derivado por el service para editar una oferta (F1a). Solo los campos que cambian. */
export type UpdatePublishedTripData = Prisma.PublishedTripUncheckedUpdateInput;

/**
 * Tupla keyset decodificada del cursor de búsqueda, DISCRIMINADA por el orden que la generó: el "reloj" del
 * keyset ES el campo del orden activo (salida → fechaHoraSalida; precio → precioBase), + id como desempate.
 * El SERVICE garantiza el invariante `cursor.orden === criteria.orden` (un cursor de otro orden se descarta
 * al decodificar): mezclar el reloj de un orden con el orderBy de otro saltearía/duplicaría filas.
 */
export type SearchKeysetCursor =
  | { orden: 'salida'; fechaHoraSalida: Date; id: string }
  | { orden: 'precio'; precioBase: number; id: string };

/**
 * Criterio de la BÚSQUEDA geo de viajes (F2, §6.2). Lo arma el SERVICE (resuelve los anillos H3, el rango
 * del día y el cursor); el repo solo traduce a la query Prisma. Es una RUTA A→B: ambos extremos deben caer
 * en su anillo (AND, no OR).
 */
export interface SearchPublishedTripsCriteria {
  /** Anillo de celdas H3 del ORIGEN (neighbors(toH3(origen),k)). La oferta debe tener origin_h3 ∈ este set. */
  originRing: string[];
  /** Anillo de celdas H3 del DESTINO. La oferta debe tener dest_h3 ∈ este set (RUTA A→B → AND con el origen). */
  destRing: string[];
  /** Asientos requeridos: asientosDisponibles >= este valor. */
  asientos: number;
  /** Estados ELEGIBLES de la oferta (PUBLICADO | PARCIALMENTE_RESERVADO). Enum tipado, sin strings sueltos. */
  estados: readonly PublishedTripState[];
  /** Inicio del rango del día pedido (inclusive). */
  desde: Date;
  /** Fin del rango del día pedido (exclusive). */
  hasta: Date;
  /** "Ahora": la salida debe ser > now() (no se ofertan viajes ya partidos). */
  ahora: Date;
  /** Orden activo de la página: `salida` (fechaHoraSalida ASC) o `precio` (precioBase ASC); id ASC desempata. */
  orden: SearchOrder;
  /** Filtro OPCIONAL de precio máximo por asiento (céntimos PEN): `precioBase <= precioMaxCents`. */
  precioMaxCents?: number;
  /** Tamaño de página. */
  take: number;
  /** Cursor keyset de la última fila de la página previa (tupla del orden activo); sin él → primera página. */
  cursor?: SearchKeysetCursor;
}

/**
 * Criterio del BROWSE del marketplace (feed público · GET /published-trips/browse). Hermano del criterio de
 * búsqueda SIN los anillos H3 ni asientos/día: el feed lista TODO lo futuro searchable, opcionalmente acotado
 * a una REGIÓN por bbox del ORIGEN del viaje (catálogo @veo/utils). Mismo orden + keyset tagueado que search.
 */
export interface BrowsePublishedTripsCriteria {
  /** Estados ELEGIBLES de la oferta (PUBLICADO | PARCIALMENTE_RESERVADO). Enum tipado, sin strings sueltos. */
  estados: readonly PublishedTripState[];
  /** "Ahora": la salida debe ser > now() — TODO lo futuro entra (sin tope de día, a diferencia del search). */
  ahora: Date;
  /** Orden activo de la página: `salida` (fechaHoraSalida ASC) o `precio` (precioBase ASC); id ASC desempata. */
  orden: SearchOrder;
  /** Filtro OPCIONAL de región: el ORIGEN del viaje (origen_lat/origen_lon) debe caer dentro del bbox. */
  bbox?: GeoBBox;
  /**
   * Filtro OPCIONAL de región DESTINO: el DESTINO del viaje (destino_lat/destino_lon) debe caer dentro de
   * este bbox. INDEPENDIENTE de `bbox` (origen): puede venir solo uno, el otro, o ambos (AND).
   */
  destBbox?: GeoBBox;
  /** Filtro OPCIONAL de precio máximo por asiento (céntimos PEN): `precioBase <= precioMaxCents`. */
  precioMaxCents?: number;
  /** Tamaño de página. */
  take: number;
  /** Cursor keyset de la última fila de la página previa (tupla del orden activo); sin él → primera página. */
  cursor?: SearchKeysetCursor;
}

/**
 * Fila CRUDA para el agregado de RUTAS POPULARES (GET /published-trips/popular-routes): solo los extremos
 * (lat/lon) + el precio por asiento. La clasificación por región es del SERVICE (regionForPoint del catálogo
 * compartido) — el repo no conoce regiones, solo materializa las columnas mínimas (sin PII, sin driverId).
 */
export interface PopularRouteSourceRow {
  origenLat: number;
  origenLon: number;
  destinoLat: number;
  destinoLon: number;
  /** Precio del asiento full-route (céntimos PEN). */
  precioBase: number;
}

/**
 * Keyset COMPARTIDO search/browse: la página arranca DESPUÉS de la tupla (valorDelOrden, id) en ASC. Tupla
 * expresada como OR para respetar el orden compuesto (no se puede usar `cursor`/`skip` de Prisma sobre una
 * columna no-única como fechaHoraSalida/precioBase sin perder filas con el mismo valor). La rama la decide
 * el TAG del cursor. Una sola definición: search y browse paginan con el MISMO reloj.
 */
function keysetWhere(cursor: SearchKeysetCursor | undefined): Prisma.PublishedTripWhereInput | undefined {
  if (cursor === undefined) return undefined;
  return cursor.orden === 'precio'
    ? {
        OR: [
          { precioBase: { gt: cursor.precioBase } },
          { precioBase: cursor.precioBase, id: { gt: cursor.id } },
        ],
      }
    : {
        OR: [
          { fechaHoraSalida: { gt: cursor.fechaHoraSalida } },
          { fechaHoraSalida: cursor.fechaHoraSalida, id: { gt: cursor.id } },
        ],
      };
}

/** orderBy espejo del keyset: el MISMO campo que cursorea es el que ordena (keyset consistente, FIX 2). */
function keysetOrderBy(orden: SearchOrder): Prisma.PublishedTripOrderByWithRelationInput[] {
  return orden === 'precio'
    ? [{ precioBase: 'asc' }, { id: 'asc' }]
    : [{ fechaHoraSalida: 'asc' }, { id: 'asc' }];
}

/** Evento de dominio a emitir en la misma tx que la mutación (outbox). */
export interface OutboxIntent {
  eventType: BookingEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class PublishedTripsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea el PublishedTrip y emite su evento en UNA transacción (outbox-in-transaction). O se persisten
   * ambos, o ninguno: nunca hay oferta sin evento ni evento sin oferta.
   */
  async createWithEvent(
    data: CreatePublishedTripData,
    intent: OutboxIntent,
  ): Promise<PublishedTrip> {
    return this.prisma.write.$transaction(async (tx) => {
      const trip = await tx.publishedTrip.create({ data });
      const envelope = createEnvelope({
        eventType: intent.eventType,
        producer: BOOKING_PRODUCER,
        payload: intent.payload,
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: intent.aggregateId,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      return trip;
    });
  }

  /**
   * Crea el PublishedTrip + su evento IDEMPOTENTEMENTE por `dedupKey` (UNIQUE). Un doble-POST con el MISMO
   * Idempotency-Key (reintento del mismo submit → misma key) NO duplica: el 2º intento choca el UNIQUE
   * (P2002 en `dedupKey`) → se devuelve la oferta ya persistida (con su evento ya emitido en la 1ª tx),
   * recuperándola del PRIMARY para no perderla por lag de réplica. Mismo patrón que bookings F0.
   *
   * `expectedDriverId` (server-truth) es el dueño esperado de la fila recuperada: la recovery re-verifica
   * ownership ANTES de devolver (anti-IDOR cross-tenant, cinturón + tiradores). Como la `dedupKey` ya viene
   * scopeada por driverId, la fila recuperada SIEMPRE debería ser de este conductor; si NO lo es, es un
   * estado inconsistente y se trata como tal — NUNCA se devuelve la oferta de otro conductor.
   */
  async createWithEventIdempotent(
    dedupKey: string,
    expectedDriverId: string,
    data: CreatePublishedTripData,
    intent: OutboxIntent,
  ): Promise<PublishedTrip> {
    try {
      return await this.createWithEvent(data, intent);
    } catch (err) {
      // Carrera/reintento de doble-submit con la misma dedupKey: el UNIQUE garantiza una sola oferta.
      if (isUniqueViolation(err, 'dedupKey')) {
        // READ-AFTER-WRITE crítico: la fila se acaba de escribir en el PRIMARY (prisma.write). Recuperarla de
        // la réplica sufriría lag → null → 409 espurio en un doble-POST legítimo. Por eso va al PRIMARY.
        const existing = await this.prisma.write.publishedTrip.findUnique({ where: { dedupKey } });
        if (existing) {
          // ANTI-IDOR CROSS-TENANT (defensa en profundidad): el namespace por driverId ya garantiza que la
          // fila es del mismo conductor; aun así re-verificamos ownership. Si NO coincide, estado inconsistente
          // — NUNCA devolvemos la oferta ajena (no se filtra PII/itinerario de otro conductor).
          if (existing.driverId !== expectedDriverId) {
            throw new ConflictError('Colisión inesperada de dedupKey entre conductores distintos', {
              dedupKey,
            });
          }
          return existing;
        }
        // El UNIQUE saltó pero ni el PRIMARY tiene la fila (estado realmente inconsistente): error tipado.
        throw new ConflictError('Oferta duplicada para la misma dedupKey', { dedupKey });
      }
      throw err;
    }
  }

  /**
   * Edita el PublishedTrip y emite su evento en UNA transacción (outbox-in-transaction), espejando
   * createWithEvent (F1a). El `where` scopea por `{ id, driverId }` (anti-IDOR a nivel de fila) Y por
   * `estado: { in: allowedStates }` (UPDATE ATÓMICO CONDICIONADO POR ESTADO, F1 FIX 1): el write SOLO aplica
   * si el estado en la PRIMARIA sigue en la lista de estados válidos para esta mutación. Cierra la ventana
   * TOCTOU — la garantía la da el WHERE atómico, no un read previo (que lee de la réplica, stale).
   *
   * Si 0 filas matchean (la fila no existe para ESE driver, o su estado YA cambió y salió de `allowedStates`),
   * Prisma lanza P2025 → se traduce a ConflictError tipado ("el viaje cambió de estado, recargá"), NUNCA un
   * 500 ni el mensaje interno de Prisma. O se persisten mutación + evento, o ninguno.
   */
  async updateWithEvent(
    id: string,
    driverId: string,
    allowedStates: readonly PublishedTripState[],
    data: UpdatePublishedTripData,
    intent: OutboxIntent,
  ): Promise<PublishedTrip> {
    try {
      return await this.prisma.write.$transaction(async (tx) => {
        const trip = await tx.publishedTrip.update({
          where: { id, driverId, estado: { in: [...allowedStates] } },
          data,
        });
        const envelope = createEnvelope({
          eventType: intent.eventType,
          producer: BOOKING_PRODUCER,
          payload: intent.payload,
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: intent.aggregateId,
            eventType: envelope.eventType,
            envelope: envelope as unknown as Prisma.InputJsonValue,
          },
        });
        return trip;
      });
    } catch (err) {
      // 0 filas matchean el where atómico (id+driverId+estado): el estado cambió bajo nuestros pies (TOCTOU)
      // o la fila no es de este driver. P2025 → ConflictError tipado, jamás un 500 ni el msg interno de Prisma.
      if (isRecordNotFound(err)) {
        throw new ConflictError('El viaje cambió de estado, recargá e intentá de nuevo', {
          id,
          allowedStates: [...allowedStates],
        });
      }
      throw err;
    }
  }

  /**
   * CANCELACIÓN ADMIN de una oferta + su evento en UNA transacción (outbox-in-transaction · finance/carpooling).
   * Espeja `updateWithEvent` PERO scopea el `where` SOLO por `{ id, estado: { in: allowedStates } }` — SIN
   * `driverId`: el admin NO es el dueño, cancela cualquier oferta viva (la autorización es RBAC del admin-bff,
   * no ownership de fila). El `estado: { in: CANCELABLE_STATES }` sigue siendo la BARRERA ATÓMICA (UPDATE
   * condicionado por estado): el write SOLO aplica si la PRIMARIA sigue en un estado cancelable → cierra TOCTOU
   * e idempotencia-segura (re-cancelar: CANCELADO ∉ CANCELABLE_STATES → 0 filas → P2025 → ConflictError, sin
   * emitir un segundo `booking.cancelled`). O se persisten mutación + evento (que libera cupos + avisa a los
   * pasajeros aguas abajo), o ninguno.
   */
  async cancelByAdminWithEvent(
    id: string,
    allowedStates: readonly PublishedTripState[],
    data: UpdatePublishedTripData,
    intent: OutboxIntent,
  ): Promise<PublishedTrip> {
    try {
      return await this.prisma.write.$transaction(async (tx) => {
        const trip = await tx.publishedTrip.update({
          where: { id, estado: { in: [...allowedStates] } },
          data,
        });
        const envelope = createEnvelope({
          eventType: intent.eventType,
          producer: BOOKING_PRODUCER,
          payload: intent.payload,
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: intent.aggregateId,
            eventType: envelope.eventType,
            envelope: envelope as unknown as Prisma.InputJsonValue,
          },
        });
        return trip;
      });
    } catch (err) {
      // 0 filas matchean el where atómico (id+estado): el estado cambió bajo nuestros pies (TOCTOU) o ya está
      // en un estado no-cancelable. P2025 → ConflictError tipado, jamás un 500 ni el msg interno de Prisma.
      if (isRecordNotFound(err)) {
        throw new ConflictError('El viaje cambió de estado, recargá e intentá de nuevo', {
          id,
          allowedStates: [...allowedStates],
        });
      }
      throw err;
    }
  }

  /** Lectura por id (GET /published-trips/:id). Usa la réplica (lectura no crítica). */
  findById(id: string): Promise<PublishedTrip | null> {
    return this.prisma.read.publishedTrip.findUnique({ where: { id } });
  }

  /**
   * BÚSQUEDA GEO de viajes publicados (F2, §6.2). Lectura ANÓNIMA no crítica → réplica. Es una RUTA A→B:
   * `origin_h3 IN originRing AND dest_h3 IN destRing` (AND, NO OR — los dos extremos deben matchear) +
   * asientosDisponibles >= asientos + estado IN estados + la salida dentro del día pedido Y futura.
   *
   * Respaldada por los índices F2 `(origin_h3, estado, fecha_hora_salida)` / `(dest_h3, ...)`: NO es full
   * scan. PAGINADO por KEYSET sobre la tupla del ORDEN ACTIVO — `orden=salida` (default): (fecha_hora_salida
   * ASC, id ASC); `orden=precio`: (precio_base ASC, id ASC). Orden estable aun con valores repetidos: el
   * cursor codifica AMBAS columnas y la condición OR del keyset evita saltos/duplicados (valor > cursor.valor,
   * O mismo valor con id > cursor.id). Un solo "reloj" compuesto POR ORDEN: el cursor viene discriminado
   * (`SearchKeysetCursor`) y el service garantiza que matchea `c.orden`.
   *
   * Filtro opcional `precioMaxCents` (precio_base <= tope): entra al WHERE con cualquiera de los dos órdenes.
   */
  searchByRoute(c: SearchPublishedTripsCriteria): Promise<PublishedTrip[]> {
    return this.prisma.read.publishedTrip.findMany({
      where: {
        originH3: { in: c.originRing },
        destH3: { in: c.destRing },
        asientosDisponibles: { gte: c.asientos },
        estado: { in: [...c.estados] },
        // Dentro del día pedido [desde, hasta) Y estrictamente futura (no se ofertan viajes ya partidos).
        fechaHoraSalida: { gte: c.desde, lt: c.hasta, gt: c.ahora },
        // Tope de precio opcional (céntimos PEN). No colisiona con el keyset de precio: este vive top-level
        // (AND) y el keyset dentro del OR.
        ...(c.precioMaxCents !== undefined ? { precioBase: { lte: c.precioMaxCents } } : {}),
        ...(keysetWhere(c.cursor) ?? {}),
      },
      // Orden de la spec §6.2 (salida más próxima primero) o por precio si el cliente lo pidió.
      orderBy: keysetOrderBy(c.orden),
      take: c.take,
    });
  }

  /**
   * BROWSE del marketplace (feed público · GET /published-trips/browse). Hermano de `searchByRoute` SIN los
   * anillos H3 / asientos / ventana de día: lista TODO lo futuro searchable (fecha_hora_salida > now), con
   * filtro OPCIONAL de REGIÓN por bbox del ORIGEN (`origen_lat BETWEEN … AND origen_lon BETWEEN …`) y tope
   * de precio. Lectura ANÓNIMA no crítica → réplica. MISMO keyset tagueado + orderBy espejo que la búsqueda
   * (helpers compartidos `keysetWhere`/`keysetOrderBy`: una sola definición de la tupla OR).
   *
   * ÍNDICES (honesto): con `orden=salida` el WHERE por estado+fecha camina el índice existente de
   * fecha_hora_salida; el filtro por bbox (origen_lat/origen_lon) NO tiene índice espacial dedicado — es un
   * refinamiento sobre el recorte por estado/fecha, aceptado para el volumen v1 del feed (si la tabla crece,
   * el siguiente paso es un índice compuesto o filtrar por region_id materializado, no PostGIS).
   */
  browseAll(c: BrowsePublishedTripsCriteria): Promise<PublishedTrip[]> {
    return this.prisma.read.publishedTrip.findMany({
      where: {
        estado: { in: [...c.estados] },
        // TODO lo futuro (sin tope de día): el feed es el marketplace completo, no un día concreto.
        fechaHoraSalida: { gt: c.ahora },
        // Región opcional: el ORIGEN del viaje debe caer dentro del bbox del catálogo (bordes inclusive).
        ...(c.bbox !== undefined
          ? {
              origenLat: { gte: c.bbox.minLat, lte: c.bbox.maxLat },
              origenLon: { gte: c.bbox.minLon, lte: c.bbox.maxLon },
            }
          : {}),
        // Región DESTINO opcional (independiente del origen): el DESTINO del viaje dentro de su bbox.
        ...(c.destBbox !== undefined
          ? {
              destinoLat: { gte: c.destBbox.minLat, lte: c.destBbox.maxLat },
              destinoLon: { gte: c.destBbox.minLon, lte: c.destBbox.maxLon },
            }
          : {}),
        ...(c.precioMaxCents !== undefined ? { precioBase: { lte: c.precioMaxCents } } : {}),
        ...(keysetWhere(c.cursor) ?? {}),
      },
      orderBy: keysetOrderBy(c.orden),
      take: c.take,
    });
  }

  /**
   * FILAS CRUDAS para el agregado de RUTAS POPULARES: los extremos + precio de las ofertas OFERTABLES
   * (estado SEARCHABLE + salida futura — MISMO universo que el browse), capadas a `cap` ordenando por salida
   * ASC (las más próximas primero, determinístico). Lectura ANÓNIMA no crítica → réplica; select mínimo
   * (sin PII, sin driverId — es un agregado de display, no expone conductores).
   *
   * CAP HONESTO de lectura: se leen hasta `cap` filas crudas y se agrega EN MEMORIA en el service. Con el
   * volumen v1 del marketplace el cap cubre el universo completo; si el volumen crece más allá del cap, el
   * agregado pasa a ser PARCIAL (sesgado a las salidas más próximas) — el siguiente paso NO es subir el cap,
   * es materializar la región por fila (columna region_id al publicar) o una vista materializada del par.
   */
  async listUpcomingForPopularRoutes(
    estados: readonly PublishedTripState[],
    ahora: Date,
    cap: number,
  ): Promise<PopularRouteSourceRow[]> {
    return this.prisma.read.publishedTrip.findMany({
      where: {
        estado: { in: [...estados] },
        fechaHoraSalida: { gt: ahora },
      },
      select: {
        origenLat: true,
        origenLon: true,
        destinoLat: true,
        destinoLon: true,
        precioBase: true,
      },
      orderBy: [{ fechaHoraSalida: 'asc' }, { id: 'asc' }],
      take: cap,
    });
  }

  /**
   * RADAR PREVIEW (endpoint interno admin): cuenta las ofertas DISPONIBLES (estado SEARCHABLE + salida futura)
   * cuyo `origin_h3` cae dentro del anillo dado. Lectura no crítica → réplica. Respaldada por el MISMO índice
   * F2 `(origin_h3, estado, fecha_hora_salida)` que la búsqueda — NO agrega estructura espacial nueva; es un
   * `COUNT` con el prefijo del índice (origin_h3 IN ring + estado IN estados + fecha_hora_salida > now).
   */
  countAvailableByOriginRing(
    originRing: string[],
    estados: readonly PublishedTripState[],
    ahora: Date,
  ): Promise<number> {
    return this.prisma.read.publishedTrip.count({
      where: {
        originH3: { in: originRing },
        estado: { in: [...estados] },
        fechaHoraSalida: { gt: ahora },
      },
    });
  }

  /**
   * MUESTRA de ORÍGENES (lat/lon) de las ofertas DISPONIBLES (estado SEARCHABLE + salida futura) cuyo
   * `origin_h3` cae dentro del anillo dado, capada a `limit`. Espeja `countAvailableByOriginRing` (mismo WHERE,
   * mismo índice F2 `(origin_h3, estado, fecha_hora_salida)`) pero materializa las coordenadas del origen para
   * que el mapa del radar admin plotee marcadores REALES (no solo conteos). Selecciona solo lat/lon (sin PII).
   * Lectura no crítica → réplica. Orden por `fecha_hora_salida` ASC (determinístico y alineado con la búsqueda).
   */
  async sampleAvailableOriginsByRing(
    originRing: string[],
    estados: readonly PublishedTripState[],
    ahora: Date,
    limit: number,
  ): Promise<{ lat: number; lon: number }[]> {
    const rows = await this.prisma.read.publishedTrip.findMany({
      where: {
        originH3: { in: originRing },
        estado: { in: [...estados] },
        fechaHoraSalida: { gt: ahora },
      },
      select: { origenLat: true, origenLon: true },
      orderBy: { fechaHoraSalida: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({ lat: r.origenLat, lon: r.origenLon }));
  }

  /**
   * Lectura por id desde el PRIMARY (prisma.write), para decisiones CRÍTICAS del write path (ownership +
   * estado en update/cancel): la réplica puede estar stale y filtrar un estado viejo. La GARANTÍA de
   * atomicidad la da igual el `where` condicionado del UPDATE; este read primary solo evita 404/mensajes
   * tempranos basados en un valor stale.
   */
  findByIdFromPrimary(id: string): Promise<PublishedTrip | null> {
    return this.prisma.write.publishedTrip.findUnique({ where: { id } });
  }

  /**
   * Lista las ofertas del conductor (GET /published-trips/mine). SCOPED por driverId server-truth — NUNCA
   * por un valor del cliente (anti-IDOR por construcción). Réplica (lectura no crítica). PAGINADO por KEYSET
   * (F1 FIX 5): `take` acota el resultado; `cursor` (id de la última fila de la página previa) avanza.
   *
   * FIX 2 — KEYSET CONSISTENTE: el `id` es uuidv7 (time-ordered), así que ORDENAMOS y CURSOREAMOS por la
   * MISMA columna (`id` DESC = más recientes primero, equivalente temporal a createdAt DESC). Un solo "reloj":
   * el cursor y el sort no pueden divergir → la página no salta ni duplica filas (antes ordenaba por createdAt
   * pero cursoreaba por id → dos relojes distintos, keyset inconsistente).
   */
  findByDriverId(driverId: string, take: number, cursorId?: string): Promise<PublishedTrip[]> {
    return this.prisma.read.publishedTrip.findMany({
      where: { driverId },
      orderBy: { id: 'desc' }, // id uuidv7 time-ordered: misma columna que el cursor → keyset consistente.
      take,
      // Keyset: arranca DESPUÉS del cursor (skip:1 salta la fila-ancla). Sin cursor → primera página.
      ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  }

  /**
   * MONITOREO admin — lista las ofertas de carpooling ACTIVAS (estado ∈ `estados`, típ. ACTIVE_CARPOOL_STATES)
   * ordenadas por salida más próxima, CAPADAS a `take`. Lectura no crítica → réplica. Respaldada por el índice
   * `(estado, fecha_hora_salida)` (el WHERE `estado IN (...)` + ORDER BY `fecha_hora_salida ASC` se sirven por
   * índice, sin full scan). Solo LECTURA (no decrementa asientos). `id` desempata el orden (determinístico).
   */
  listActiveCarpools(
    estados: readonly PublishedTripState[],
    take: number,
  ): Promise<PublishedTrip[]> {
    return this.prisma.read.publishedTrip.findMany({
      where: { estado: { in: [...estados] } },
      orderBy: [{ fechaHoraSalida: 'asc' }, { id: 'asc' }],
      take,
    });
  }

  /**
   * AGREGADOS de los carpools ACTIVOS para los KPIs (una sola pasada agregada, MISMO filtro que
   * `listActiveCarpools`): `count` = TOTAL real de ofertas activas (no la página capada) y `_sum` de asientos
   * totales/disponibles → deja computar ocupación (reservados = totales − disponibles) y cupos libres
   * server-side, sin materializar todas las filas. Réplica. `_sum` es NULL si no hay filas → se normaliza a 0.
   */
  async aggregateActiveCarpools(estados: readonly PublishedTripState[]): Promise<{
    count: number;
    asientosTotales: number;
    asientosDisponibles: number;
  }> {
    const agg = await this.prisma.read.publishedTrip.aggregate({
      where: { estado: { in: [...estados] } },
      _count: { _all: true },
      _sum: { asientosTotales: true, asientosDisponibles: true },
    });
    return {
      count: agg._count._all,
      asientosTotales: agg._sum.asientosTotales ?? 0,
      asientosDisponibles: agg._sum.asientosDisponibles ?? 0,
    };
  }

  /** Cuenta las ofertas en UN estado (KPI "en ruta ahora" = EN_RUTA). Réplica; índice `(estado, fecha_hora_salida)`. */
  countByState(estado: PublishedTripState): Promise<number> {
    return this.prisma.read.publishedTrip.count({ where: { estado } });
  }
}
