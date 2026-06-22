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
import { createEnvelope } from '@veo/events';
import { isUniqueViolation, isRecordNotFound } from '@veo/database';
import { ConflictError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { BookingState, Prisma, type Booking, type PublishedTrip } from '../generated/prisma';
import { BOOKING_PRODUCER, type BookingEventType } from '../events/booking-events';

export type CreateBookingData = Prisma.BookingUncheckedCreateInput;

/** Evento de dominio a emitir en la misma tx que la mutación (outbox). */
export interface OutboxIntent {
  eventType: BookingEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
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
   * NOTA F0: NO se decrementa `asientosDisponibles` acá — el decremento ocurrirá al CONFIRMAR (handler de
   * payment.captured, §6), que es F3b · PENDIENTE (aún no existe). La creación de la reserva no toca el cupo
   * de la oferta; el decremento atómico se construirá en F3b.
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
    });
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
   * que es F3c · PENDIENTE (aún no existe). approve/reject sólo mueven el eje Booking.estado.
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
      });
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
}
