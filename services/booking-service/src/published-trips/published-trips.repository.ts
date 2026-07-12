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
import { ConflictError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, PublishedTripState, type PublishedTrip } from '../generated/prisma';
import { BOOKING_PRODUCER, type BookingEventType } from '../events/booking-events';

/** Datos ya validados/derivados por el service para materializar la fila PublishedTrip. */
export type CreatePublishedTripData = Prisma.PublishedTripUncheckedCreateInput;

/** Patch ya validado/derivado por el service para editar una oferta (F1a). Solo los campos que cambian. */
export type UpdatePublishedTripData = Prisma.PublishedTripUncheckedUpdateInput;

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
  /** Tamaño de página. */
  take: number;
  /** Cursor keyset (fechaHoraSalida, id) de la última fila de la página previa; sin él → primera página. */
  cursor?: { fechaHoraSalida: Date; id: string };
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
   * scan. PAGINADO por KEYSET sobre la tupla (fecha_hora_salida ASC, id ASC) — orden estable aun con varias
   * salidas a la misma hora: el cursor codifica AMBAS columnas y la condición OR del keyset evita saltos/
   * duplicados (fecha > cursor.fecha, O misma fecha con id > cursor.id). Un solo "reloj" compuesto.
   */
  searchByRoute(c: SearchPublishedTripsCriteria): Promise<PublishedTrip[]> {
    // Keyset: la página arranca DESPUÉS de (cursor.fechaHoraSalida, cursor.id) en orden ASC. Tupla expresada
    // como OR para respetar el orden compuesto (no se puede usar `cursor`/`skip` de Prisma sobre una columna
    // no-única como fechaHoraSalida sin perder filas con la misma hora).
    const keyset: Prisma.PublishedTripWhereInput | undefined = c.cursor
      ? {
          OR: [
            { fechaHoraSalida: { gt: c.cursor.fechaHoraSalida } },
            { fechaHoraSalida: c.cursor.fechaHoraSalida, id: { gt: c.cursor.id } },
          ],
        }
      : undefined;

    return this.prisma.read.publishedTrip.findMany({
      where: {
        originH3: { in: c.originRing },
        destH3: { in: c.destRing },
        asientosDisponibles: { gte: c.asientos },
        estado: { in: [...c.estados] },
        // Dentro del día pedido [desde, hasta) Y estrictamente futura (no se ofertan viajes ya partidos).
        fechaHoraSalida: { gte: c.desde, lt: c.hasta, gt: c.ahora },
        ...(keyset ?? {}),
      },
      // Orden de la spec §6.2: salida más próxima primero. id ASC desempata (keyset estable).
      orderBy: [{ fechaHoraSalida: 'asc' }, { id: 'asc' }],
      take: c.take,
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
