/**
 * BookingsRepository — acceso Prisma al agregado Booking (schema 'booking'). Encapsula el patrón
 * OUTBOX-EN-TRANSACCIÓN: la creación de la reserva y el INSERT de su evento (`booking.requested` en
 * REVISION, `booking.approved` en INSTANT) van en la MISMA transacción Prisma (atomicidad estado↔evento,
 * FOUNDATION §6 / ADR-014 §7).
 *
 * Idempotencia de request: `createWithEventIdempotent` atrapa la violación de UNIQUE (`dedupKey`, P2002) de
 * un doble-POST y devuelve el Booking ya existente — una sola fila, mismo patrón que payment-service.
 *
 * ANTI-IDOR CROSS-TENANT (cinturón + tiradores): la `dedupKey` ya viene scopeada por `passengerId` desde el
 * service (`booking:req:{passengerId}:{key}`), así que la fila recuperada tras P2002 SIEMPRE es del mismo
 * pasajero. Aun así, la recovery re-verifica `existing.passengerId === expectedPassengerId` ANTES de devolver:
 * si por cualquier causa NO coincide (no debería pasar nunca), trata la fila como ajena y lanza un error
 * tipado — JAMÁS devuelve la reserva de otro pasajero. Defensa en profundidad: el namespace previene la
 * colisión; el chequeo garantiza que un fallo del namespace nunca filtre PII ajena.
 */
import { Injectable } from '@nestjs/common';
import { createEnvelope, BookingCancelledRazon } from '@veo/events';
import { isUniqueViolation, isRecordNotFound } from '@veo/database';
import { ConflictError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import {
  BookingState,
  Prisma,
  PublishedTripState,
  type Booking,
  type PublishedTrip,
} from '../generated/prisma';
import { publishedTripMachine, isReservableState } from '../domain/published-trip-state';
import { bookingMachine } from '../domain/booking-state';
import { BOOKING_PRODUCER, BookingEventType } from '../events/booking-events';

export type CreateBookingData = Prisma.BookingUncheckedCreateInput;

/**
 * Presupuesto EXPLÍCITO de las transacciones del repo (vs el default IMPLÍCITO de Prisma de 5000ms). El
 * seat-lock es el hot-path financiero MÁS crítico: sostiene un `SELECT ... FOR UPDATE` bajo contención (los
 * handlers concurrentes del MISMO viaje se serializan esperando el lock de fila), así que necesita un techo
 * holgado para no abortar una confirmación legítima por un pico de espera. Se calibra al mismo valor que el
 * outbox drain compartido (`{ timeout: 15_000 }` · @veo/database/outbox) — referencia ya probada en este
 * repo para trabajo transaccional sostenido. `maxWait` (cuánto esperar un slot del pool ANTES de empezar) se
 * deja en 5000ms: si el pool está saturado 5s, fallar rápido es preferible a encolar. Las OTRAS tx del repo
 * (createWithEvent, transitionWithEvent, cancelForPaymentFailed) usan el MISMO presupuesto por consistencia
 * (son más livianas que el seat-lock, pero homogeneizar el techo evita sorpresas de calibración dispar). En
 * particular transitionWithEvent respalda approve()/reject()/cancelForChargeRejected() — path financiero, así
 * que NO debe caer al default implícito de Prisma (5000ms).
 */
const TX_TIMEOUT_MS = 15_000;
const TX_MAX_WAIT_MS = 5_000;
const TX_OPTIONS = { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS } as const;

/** Evento de dominio a emitir en la misma tx que la mutación (outbox). */
export interface OutboxIntent {
  eventType: BookingEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/** Resultado del seat-lock atómico (§6): qué pasó con el booking y la oferta tras intentar confirmar. */
export type ConfirmSeatOutcome =
  | { kind: 'CONFIRMED'; booking: Booking; tripQuedoLleno: boolean }
  | { kind: 'SEAT_FULL'; booking: Booking }
  | { kind: 'OFFER_UNAVAILABLE'; booking: Booking }
  | { kind: 'NOOP' };

/** Fila mínima leída con FOR UPDATE: solo lo que el lock necesita decidir (asientos + estado de la oferta). */
interface LockedTripRow {
  asientos_disponibles: number;
  estado: PublishedTripState;
}

@Injectable()
export class BookingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Lee la oferta sobre la que se reserva (para validar modo/precio/cupo). Réplica. */
  findPublishedTrip(id: string): Promise<PublishedTrip | null> {
    return this.prisma.read.publishedTrip.findUnique({ where: { id } });
  }

  /**
   * Crea el Booking y emite su evento en UNA transacción (outbox-in-transaction). O ambos, o ninguno.
   * NOTA F0: NO se decrementa `asientosDisponibles` acá — el decremento ocurre al CONFIRMAR (handler de
   * payment.captured, §6), que es F3c · CONSTRUIDO (ver `confirmAndLockSeats` abajo). La creación de la
   * reserva no toca el cupo de la oferta; el decremento atómico vive en el seat-lock del §6.
   */
  async createWithEvent(data: CreateBookingData, intent: OutboxIntent): Promise<Booking> {
    return this.prisma.write.$transaction(async (tx) => {
      const booking = await tx.booking.create({ data });
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
      return booking;
    }, TX_OPTIONS);
  }

  /**
   * Crea el Booking + su evento IDEMPOTENTEMENTE por `dedupKey` (UNIQUE). Un doble-POST con el MISMO
   * Idempotency-Key (reintento del mismo submit → misma key) NO duplica: el 2º intento choca el UNIQUE
   * (P2002) → se devuelve el Booking ya persistido (con su evento ya emitido en la 1ª tx), recuperándolo del
   * PRIMARY para no perderlo por lag de réplica. Mismo patrón que payment-service `charge`.
   *
   * `expectedPassengerId` (server-truth) es el dueño esperado de la fila recuperada: la recovery re-verifica
   * ownership ANTES de devolver (anti-IDOR cross-tenant, cinturón + tiradores). Como la `dedupKey` ya viene
   * scopeada por passengerId, la fila recuperada SIEMPRE debería ser de este pasajero; si NO lo es, es un
   * estado inconsistente y se trata como tal — nunca se devuelve la reserva de otro pasajero.
   */
  async createWithEventIdempotent(
    dedupKey: string,
    expectedPassengerId: string,
    data: CreateBookingData,
    intent: OutboxIntent,
  ): Promise<Booking> {
    try {
      return await this.createWithEvent(data, intent);
    } catch (err) {
      // Carrera/reintento de doble-submit con la misma dedupKey: el UNIQUE garantiza una sola reserva.
      if (isUniqueViolation(err, 'dedupKey')) {
        // READ-AFTER-WRITE crítico: la fila se acaba de escribir en el PRIMARY (prisma.write). Recuperarla
        // desde la réplica (prisma.read) sufriría lag → null → 409 espurio en un doble-POST legítimo. Por eso
        // el read de recuperación VA AL PRIMARY: el reintento siempre encuentra la fila recién escrita.
        const existing = await this.prisma.write.booking.findUnique({ where: { dedupKey } });
        if (existing) {
          // ANTI-IDOR CROSS-TENANT (defensa en profundidad): el namespace por passengerId ya garantiza que la
          // fila es del mismo pasajero; aun así, re-verificamos ownership antes de devolverla. Si NO coincide,
          // es un estado inconsistente — NUNCA devolvemos la reserva ajena (no se filtra PII de otro tenant).
          if (existing.passengerId !== expectedPassengerId) {
            throw new ConflictError('Colisión inesperada de dedupKey entre pasajeros distintos', {
              dedupKey,
            });
          }
          return existing;
        }
        // El UNIQUE saltó pero ni el PRIMARY tiene la fila (estado realmente inconsistente): error tipado.
        throw new ConflictError('Reserva duplicada para la misma dedupKey', { dedupKey });
      }
      throw err;
    }
  }

  /** Lectura por id (GET /bookings/:id). Réplica. El gate de ownership (anti-IDOR) vive en el service. */
  findById(id: string): Promise<Booking | null> {
    return this.prisma.read.booking.findUnique({ where: { id } });
  }

  /**
   * Lectura por id desde el PRIMARY (prisma.write), para decisiones CRÍTICAS del write path del driver-rail
   * (approve/reject): la réplica puede estar stale y filtrar un estado viejo. La GARANTÍA de atomicidad la da
   * igual el `where` condicionado por estado del UPDATE; este read primary solo evita 404/mensajes tempranos
   * basados en un valor stale (mismo patrón que findByIdFromPrimary de PublishedTripsRepository).
   */
  findByIdFromPrimary(id: string): Promise<Booking | null> {
    return this.prisma.write.booking.findUnique({ where: { id } });
  }

  /**
   * Lista las solicitudes (Bookings) de un PublishedTrip (GET /published-trips/:id/bookings · driver-rail).
   * El OWNERSHIP del viaje lo valida el service contra el driverId server-truth ANTES de llamar acá (no se
   * filtra por driverId aquí: el Booking no porta driverId — lo porta el PublishedTrip, ya validado). Réplica
   * (lectura no crítica). PAGINADO por KEYSET sobre `id` (uuidv7 time-ordered): mismo "reloj" para sort y
   * cursor → keyset consistente, no salta ni duplica filas (espeja findByDriverId de PublishedTripsRepository).
   */
  findByPublishedTripId(
    publishedTripId: string,
    take: number,
    cursorId?: string,
  ): Promise<Booking[]> {
    return this.prisma.read.booking.findMany({
      where: { publishedTripId },
      orderBy: { id: 'desc' }, // id uuidv7 time-ordered: misma columna que el cursor → keyset consistente.
      take,
      // Keyset: arranca DESPUÉS del cursor (skip:1 salta la fila-ancla). Sin cursor → primera página.
      ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  }

  /**
   * Transición de estado de un Booking + su evento en UNA transacción (outbox-in-transaction). El `where`
   * incluye `estado: { in: allowedStates }` además de `{ id }` (UPDATE ATÓMICO CONDICIONADO POR ESTADO): el
   * write SOLO aplica si el estado en la PRIMARIA sigue en la lista válida → cierra la ventana TOCTOU y vuelve
   * la operación idempotente-segura (un doble-tap: el 2º no matchea el estado ya mutado → 0 filas → P2025 →
   * ConflictError, sin emitir un segundo evento). El service ya validó la transición con assertTransition; este
   * where es la SEGUNDA barrera atómica (la regla + el candado, espeja updateWithEvent de PublishedTripsRepo).
   *
   * NO decrementa `asientosDisponibles`: el decremento atómico vive en el handler de payment.captured (§6),
   * que es F3c · CONSTRUIDO (`confirmAndLockSeats`). approve/reject sólo mueven el eje Booking.estado.
   */
  async transitionWithEvent(
    id: string,
    allowedStates: readonly BookingState[],
    data: Prisma.BookingUncheckedUpdateInput,
    intent: OutboxIntent,
  ): Promise<Booking> {
    try {
      return await this.prisma.write.$transaction(async (tx) => {
        const booking = await tx.booking.update({
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
        return booking;
      }, TX_OPTIONS);
    } catch (err) {
      // 0 filas matchean el where atómico (id + estado): el estado cambió bajo nuestros pies (doble-tap /
      // TOCTOU) o la fila no existe. P2025 → ConflictError tipado, jamás un 500 ni el msg interno de Prisma.
      if (isRecordNotFound(err)) {
        throw new ConflictError('La reserva cambió de estado, recargá e intentá de nuevo', {
          id,
          allowedStates: [...allowedStates],
        });
      }
      throw err;
    }
  }

  /**
   * Transición APROBADO → COBRO_PENDIENTE + persistir el `paymentId` del charge, SIN emitir evento (el
   * `booking.approved` ya se emitió en la tx1 de approve()/reserve()-INSTANT). Es la tx2 del patrón de
   * atomicidad cross-service (§5.2): el CHARGE REST corre ENTRE la tx1 (que aprobó) y ESTA tx2 (que registra
   * que el cobro se disparó) — NUNCA dentro de una $transaction Prisma (es I/O externa). El `where` exige
   * `estado: APROBADO` (idempotencia: si ya pasó a COBRO_PENDIENTE, 0 filas → P2025 → ConflictError, no se
   * re-registra). Devuelve el Booking actualizado.
   */
  async markChargePending(id: string, paymentId: string): Promise<Booking> {
    try {
      return await this.prisma.write.booking.update({
        where: { id, estado: BookingState.APROBADO },
        data: { estado: BookingState.COBRO_PENDIENTE, paymentId },
      });
    } catch (err) {
      if (isRecordNotFound(err)) {
        throw new ConflictError('La reserva ya no está APROBADA (cobro ya registrado o estado cambió)', {
          id,
        });
      }
      throw err;
    }
  }

  /**
   * Lee el Booking por id desde el PRIMARY (prisma.write) para el handler de payment.captured/failed. La
   * correlación llega como `tripId = bookingId` (opaco) en el evento de payment-service (ADR-014 §5.5/§6): se
   * ubica el Booking directo por id, SIN GetPaymentByTrip. Read del PRIMARY: la decisión del seat-lock no
   * puede apoyarse en una réplica stale. El where atómico del UPDATE da igual la garantía dura; este read solo
   * evita actuar sobre un estado viejo / emitir mensajes incorrectos.
   */
  findByIdForCaptureHandler(id: string): Promise<Booking | null> {
    return this.prisma.write.booking.findUnique({ where: { id } });
  }

  /**
   * EL SEAT-LOCK ATÓMICO (ADR-014 §6) — el ÚNICO anti-oversold del sistema. Corre DENTRO del handler de
   * `payment.captured` (la captura llegó por webhook/poll, minutos después del CHARGE). TODO en UNA transacción
   * ACID con BLOQUEO PESIMISTA DE FILA (`SELECT ... FOR UPDATE`): chequear-cupo + decrementar + transición +
   * outbox van JUNTOS — NUNCA chequear y confirmar en pasos separados (sería la grieta de carrera del §6).
   *
   * SECUENCIA (§6):
   *  1. `SELECT asientos_disponibles, estado FROM published_trips WHERE id = ? FOR UPDATE` → lock pesimista de
   *     la fila de la OFERTA. Serializa los handlers concurrentes del MISMO viaje: el 2º espera al 1º y RE-LEE
   *     el valor ya decrementado. (Read Committed default basta: el lock de fila ya serializa; NO Serializable
   *     — daría retries innecesarios.)
   *  2. ¿Hay cupo? `asientos_disponibles >= booking.asientos` (MULTI-ASIENTO: un booking reserva N, no 1).
   *  3a. HAY CUPO → decrementá `asientos_disponibles -= booking.asientos`; assertTransition + UPDATE booking →
   *      CONFIRMADO (where atómico por estado: COBRO_PENDIENTE); outbox `booking.confirmed`; si el restante
   *      llegó a 0 → assertTransition + UPDATE oferta → LLENO; si era el 1º decremento (de asientosTotales) →
   *      PARCIALMENTE_RESERVADO. Todo en la misma tx (outbox-en-transacción).
   *  3b. ASIENTO LLENO (`< booking.asientos`) → assertTransition + UPDATE booking → CANCELADO (where atómico);
   *      outbox `booking.cancelled` razon=ASIENTO_LLENO (cobré pero otro se llevó el asiento → payment hará el
   *      Refund en F3c-payment · PENDIENTE). Misma tx. La OFERTA no se toca (el asiento no se liberó: nunca fue
   *      de este booking).
   *
   * IDEMPOTENCIA (doble protección, tolera duplicado Y reorden de Kafka):
   *  - El UPDATE del booking va condicionado por `where: { estado: COBRO_PENDIENTE }` (CAS atómico). Un
   *    `payment.captured` DUPLICADO sobre un booking YA CONFIRMADO → 0 filas → P2025 → outcome NOOP (no
   *    doble-decremento). NUNCA se decrementa dos veces.
   *  - Esto + el dedup por eventId del consumer = doble barrera.
   *
   * El `precheck` (estado actual del booking) lo lee el caller con findByIdForCaptureHandler ANTES, fuera del
   * lock, solo para early-return barato (NOOP si ya no está en COBRO_PENDIENTE); la GARANTÍA la da el where
   * atómico DENTRO de la tx, no ese precheck.
   */
  async confirmAndLockSeats(
    booking: Booking,
    paymentId: string,
  ): Promise<ConfirmSeatOutcome> {
    return this.prisma.write.$transaction(async (tx) => {
      // 1. LOCK PESIMISTA de la fila de la oferta. (timeout/maxWait EXPLÍCITOS abajo · TX_OPTIONS — hot-path.) $queryRaw parametrizado (Prisma.sql) — nunca interpolación
      //    cruda. Devuelve [] si la oferta no existe (no debería: el booking referencia un PublishedTrip real).
      const rows = await tx.$queryRaw<LockedTripRow[]>(
        Prisma.sql`SELECT asientos_disponibles, estado
                   FROM booking.published_trips
                   WHERE id = ${booking.publishedTripId}::uuid
                   FOR UPDATE`,
      );
      const trip = rows[0];
      if (!trip) {
        // Oferta inexistente bajo el lock: estado inconsistente. No confirmamos ni decrementamos nada.
        throw new ConflictError('La oferta del booking no existe (no se puede confirmar el asiento)', {
          publishedTripId: booking.publishedTripId,
          bookingId: booking.id,
        });
      }

      // 1.bis GUARD DEFENSIVO (§6 · F3c): ¿la oferta sigue en un estado RESERVABLE? Hoy es inocuo (EN_RUTA no
      //     es alcanzable: su transición clock-driven es F4), pero un `payment.captured` TARDÍO sobre una oferta
      //     ya NO reservable (futuro EN_RUTA/COMPLETADO/CANCELADO) llevaría a `assertTransition(EN_RUTA → LLENO)`
      //     DENTRO de la txn → throw → rollback → re-throw → POISON infinito (la partición se estanca). En vez de
      //     envenenar, CANCELAMOS limpio: el pasajero cobró pero la oferta ya no admite la reserva → razon=
      //     OFERTA_NO_DISPONIBLE (CON Refund, hubo captura, igual que ASIENTO_LLENO · F3c-payment). NO construye
      //     F4: solo evita el poison-pill. Idempotente por el where atómico (estado: COBRO_PENDIENTE).
      if (!isReservableState(trip.estado)) {
        const cancelled = await this.transitionBookingInTx(
          tx,
          booking.id,
          BookingState.CANCELADO,
          {},
          {
            eventType: BookingEventType.CANCELLED,
            aggregateId: booking.id,
            payload: {
              bookingId: booking.id,
              razon: BookingCancelledRazon.OFERTA_NO_DISPONIBLE,
              estado: BookingState.CANCELADO,
              estadoAnterior: BookingState.COBRO_PENDIENTE,
              paymentId,
            },
          },
        );
        if (!cancelled) return { kind: 'NOOP' }; // duplicado/reorden: ya no estaba en COBRO_PENDIENTE.
        return { kind: 'OFFER_UNAVAILABLE', booking: cancelled };
      }

      // 2. ¿Hay cupo para los N asientos de ESTE booking? (multi-asiento, no 1).
      const hayCupo = trip.asientos_disponibles >= booking.asientos;

      if (!hayCupo) {
        // 3b. CAMINO INFELIZ (§6): cobré pero el asiento ya se llenó (otro confirmó primero). El booking se
        //     CANCELA; payment hará el Refund (razon=ASIENTO_LLENO). La oferta NO se toca.
        const cancelled = await this.transitionBookingInTx(
          tx,
          booking.id,
          BookingState.CANCELADO,
          {},
          {
            eventType: BookingEventType.CANCELLED,
            aggregateId: booking.id,
            payload: {
              bookingId: booking.id,
              razon: BookingCancelledRazon.ASIENTO_LLENO,
              estado: BookingState.CANCELADO,
              estadoAnterior: BookingState.COBRO_PENDIENTE,
              paymentId,
            },
          },
        );
        if (!cancelled) return { kind: 'NOOP' }; // 0 filas: ya no estaba en COBRO_PENDIENTE (duplicado/reorden).
        return { kind: 'SEAT_FULL', booking: cancelled };
      }

      // 3a. HAY CUPO → confirmar. Primero la transición del booking (where atómico por estado): si 0 filas
      //     (duplicado de payment.captured sobre un booking ya confirmado), ABORTAMOS sin decrementar (NOOP).
      const confirmed = await this.transitionBookingInTx(
        tx,
        booking.id,
        BookingState.CONFIRMADO,
        { paymentId },
        {
          eventType: BookingEventType.CONFIRMED,
          aggregateId: booking.id,
          payload: {
            bookingId: booking.id,
            publishedTripId: booking.publishedTripId,
            passengerId: booking.passengerId,
            asientos: booking.asientos,
            precioAcordado: booking.precioAcordado,
            paymentId,
            estado: BookingState.CONFIRMADO,
          },
        },
      );
      if (!confirmed) return { kind: 'NOOP' }; // duplicado/reorden: el booking ya no estaba en COBRO_PENDIENTE.

      // DECREMENTO del asiento (dentro del lock: serializado con los handlers concurrentes del mismo viaje).
      const restante = trip.asientos_disponibles - booking.asientos;
      await tx.publishedTrip.update({
        where: { id: booking.publishedTripId },
        data: { asientosDisponibles: restante },
      });

      // Transición de la OFERTA derivada del restante (cero strings mágicos: assertTransition antes de mutar):
      //  - restante == 0 → LLENO.
      //  - era el 1er decremento (estado seguía PUBLICADO) y queda cupo → PARCIALMENTE_RESERVADO.
      //  - ya PARCIALMENTE_RESERVADO con cupo → sin cambio de estado (solo bajó el contador).
      const tripQuedoLleno = restante === 0;
      const nuevoEstadoOferta = this.computeOfferStateAfterDecrement(trip.estado, restante);
      if (nuevoEstadoOferta && nuevoEstadoOferta !== trip.estado) {
        publishedTripMachine.assertTransition(trip.estado, nuevoEstadoOferta);
        await tx.publishedTrip.update({
          where: { id: booking.publishedTripId },
          data: { estado: nuevoEstadoOferta },
        });
      }

      return { kind: 'CONFIRMED', booking: confirmed, tripQuedoLleno };
    }, TX_OPTIONS);
  }

  /**
   * Cancela un booking que estaba en COBRO_PENDIENTE por un cobro FALLIDO permanente (payment.failed
   * willRetry=false · BR-P02 agotado · ADR-014 §5.4): COBRO_PENDIENTE → CANCELADO + outbox `booking.cancelled`
   * razon=COBRO_FALLIDO, en UNA tx (outbox-en-transacción). NO hay Refund (nunca se capturó). El asiento NO se
   * decrementó (solo se decrementa al CONFIRMAR), así que la oferta queda intacta. Where atómico por estado:
   * un evento DUPLICADO o un booking ya movido → 0 filas → null (no-op, sin doble-evento).
   */
  async cancelForPaymentFailed(bookingId: string): Promise<Booking | null> {
    return this.prisma.write.$transaction(
      async (tx) =>
        this.transitionBookingInTx(
          tx,
          bookingId,
          BookingState.CANCELADO,
          {},
          {
            eventType: BookingEventType.CANCELLED,
            aggregateId: bookingId,
            payload: {
              bookingId,
              razon: BookingCancelledRazon.COBRO_FALLIDO,
              estado: BookingState.CANCELADO,
              estadoAnterior: BookingState.COBRO_PENDIENTE,
            },
          },
        ),
      TX_OPTIONS,
    );
  }

  /**
   * Transición de UN booking DENTRO de una tx ya abierta (el seat-lock / cancel-failed la comparten con el
   * decremento o el lock). UPDATE ATÓMICO CONDICIONADO POR ESTADO: el `where` exige `estado: COBRO_PENDIENTE`
   * → cierra la ventana TOCTOU y vuelve la operación idempotente (duplicado/reorden de Kafka → 0 filas →
   * devuelve null, el caller decide NOOP). La REGLA primero: assertTransition(COBRO_PENDIENTE → target) valida
   * la legalidad antes del UPDATE (espeja transitionWithEvent). Emite el outbox en la MISMA tx.
   * `extraData` lleva mutaciones adicionales del booking (p.ej. paymentId al confirmar).
   */
  private async transitionBookingInTx(
    tx: Prisma.TransactionClient,
    bookingId: string,
    target: BookingState,
    extraData: Prisma.BookingUncheckedUpdateInput,
    intent: OutboxIntent,
  ): Promise<Booking | null> {
    // La REGLA, no el if: la única transición que el handler de captura/fallo dispara es desde COBRO_PENDIENTE.
    bookingMachine.assertTransition(BookingState.COBRO_PENDIENTE, target);
    const updated = await tx.booking.updateMany({
      where: { id: bookingId, estado: BookingState.COBRO_PENDIENTE },
      data: { estado: target, ...extraData },
    });
    if (updated.count === 0) return null; // duplicado/reorden: ya no estaba en COBRO_PENDIENTE → no-op.

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
    // Re-leemos la fila ya mutada (dentro de la tx, consistente) para devolverla al caller.
    return tx.booking.findUnique({ where: { id: bookingId } });
  }

  /**
   * Estado de la OFERTA tras decrementar (derivado, cero strings mágicos). null = sin cambio de estado (solo
   * bajó el contador). LLENO si no queda cupo; PARCIALMENTE_RESERVADO si era el 1er decremento desde PUBLICADO
   * y aún queda cupo. Si ya estaba PARCIALMENTE_RESERVADO con cupo → null (no re-transiciona).
   */
  private computeOfferStateAfterDecrement(
    actual: PublishedTripState,
    restante: number,
  ): PublishedTripState | null {
    if (restante === 0) return PublishedTripState.LLENO;
    if (actual === PublishedTripState.PUBLICADO) return PublishedTripState.PARCIALMENTE_RESERVADO;
    return null; // ya PARCIALMENTE_RESERVADO con cupo (u otro estado): solo bajó el contador.
  }
}
