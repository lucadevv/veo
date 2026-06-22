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
import { isUniqueViolation } from '@veo/database';
import { ConflictError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Booking, type PublishedTrip } from '../generated/prisma';
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
   * NOTA F0: NO se decrementa `asientosDisponibles` acá — el decremento ocurre al CONFIRMAR (handler de
   * payment.captured, §6) que es F3. La creación de la reserva no toca el cupo de la oferta.
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
}
