/**
 * BookingPaymentConsumer — el PRIMER consumer Kafka del booking-service (F3c · ADR-014 §6 · §5.2 paso 3 ·
 * §7.1.bis). Reacciona al cobro ASÍNCRONO: payment-service emite `payment.captured` / `payment.failed` cuando
 * el webhook/poll resuelve la captura (minutos después del CHARGE), y booking corre la txn atómica del §6.
 *
 * REGLA DE ORO (@veo/events/nest): un groupId = UN consumer (esta clase) con TODOS sus eventos en `handlers()`.
 * Por eso `payment.captured` Y `payment.failed` se registran JUNTOS en el mismo record — jamás dos consumers
 * con el mismo groupId y topics distintos (dejaría particiones sin asignar → eventos estancados).
 *
 * DEDUP IDEMPOTENTE (packages/events/dedup): cada handler va envuelto en `processEventOnce(... envelope.eventId
 * ...)` — marca DESPUÉS del éxito (si el handler lanza, NO se escribe la marca y kafkajs reintenta sin perder
 * la señal). El `eventId` es el UUIDv7 ÚNICO del envelope. Esto es UNA de las dos barreras de idempotencia del
 * seat-lock; la otra (la dura) es el `where` atómico `estado: COBRO_PENDIENTE` del UPDATE dentro de la txn
 * (BookingsRepository.confirmAndLockSeats) → juntas toleran duplicado Y reorden, NUNCA doble-decremento.
 *
 * PAYLOAD INVÁLIDO → warn + return (no romper el stream): defensa en profundidad (KafkaEventConsumer ya
 * descarta payloads inválidos antes del handler). CORRELACIÓN: el payload trae `tripId = bookingId` (UUID
 * OPACO · §5.5) → el service ubica el Booking por id directo (sin GetPaymentByTrip).
 *
 * NO SKILL NestJS: no había una skill de NestJS en el registro para cargar antes — se siguió el patrón REAL del
 * repo (DispatchConsumer de trip-service + ErasureConsumer de media-service) como plantilla.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  processEventOnce,
  schemaForEvent,
  type EventEnvelope,
  type EventHandler,
  type EventPayload,
} from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import type { Redis } from '@veo/redis';
import { BookingsService } from './bookings.service';
import { BOOKING_PAYMENT_EVENT_DEDUP } from './dedup.options';
import { REDIS } from '../infra/redis';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio (ADR-014: brokers de KAFKA_BROKERS). */
const KAFKA_CLIENT_ID = 'booking-service';

/** Group ÚNICO del cobro async: ESTE consumer suscribe payment.captured + payment.failed (regla de oro). */
const PAYMENT_GROUP_ID = 'booking-service.payment';

/** Eventos consumidos (TIPADOS, cero strings mágicos sueltos): los que payment-service emite (§7.1.bis). */
const PAYMENT_CAPTURED = 'payment.captured' as const;
const PAYMENT_FAILED = 'payment.failed' as const;

@Injectable()
export class BookingPaymentConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly bookings: BookingsService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: PAYMENT_GROUP_ID,
    });
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro · regla de oro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      [PAYMENT_CAPTURED]: (envelope) => this.onPaymentCaptured(envelope),
      [PAYMENT_FAILED]: (envelope) => this.onPaymentFailed(envelope),
    };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Suscrito a ${eventTypes.join(' + ')} (cobro asíncrono del carpooling · seat-lock §6)`;
  }

  /**
   * `payment.captured` → seat-lock atómico (§6). Valida el payload; correlaciona por `tripId = bookingId`
   * (opaco); delega en `bookings.confirmCapture`. Envuelto en dedup por eventId (marca tras el éxito). Si el
   * handler lanza, se relanza para que kafkajs reintente (el dedup NO se marcó).
   */
  private async onPaymentCaptured(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = schemaForEvent(PAYMENT_CAPTURED)?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn(`${PAYMENT_CAPTURED} con payload inválido (eventId=${envelope.eventId}); ignorado`);
      return;
    }
    const { tripId, paymentId } = parsed.data as EventPayload<typeof PAYMENT_CAPTURED>;
    try {
      await processEventOnce(this.redis, BOOKING_PAYMENT_EVENT_DEDUP, envelope.eventId, () =>
        // tripId = bookingId (UUID opaco · §5.5): el service ubica el Booking por id.
        this.bookings.confirmCapture(tripId, paymentId),
      );
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó → el reintento re-procesa (idempotente por el
      // where atómico del seat-lock). Log estructurado para diagnóstico.
      this.logger.error({ err, tripId, paymentId }, 'Falló el seat-lock al confirmar la captura del cobro');
      throw err;
    }
  }

  /**
   * `payment.failed` → BR-P02 (§5.4). Los reintentos del riel los hace payment INTERNAMENTE; booking solo
   * reacciona: willRetry=true → no-op (espera); willRetry=false → CANCELADO (razon=COBRO_FALLIDO). Dedup por
   * eventId + where atómico por estado (idempotente). Payload inválido → warn + return.
   */
  private async onPaymentFailed(envelope: EventEnvelope<unknown>): Promise<void> {
    const parsed = schemaForEvent(PAYMENT_FAILED)?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn(`${PAYMENT_FAILED} con payload inválido (eventId=${envelope.eventId}); ignorado`);
      return;
    }
    const { tripId, willRetry } = parsed.data as EventPayload<typeof PAYMENT_FAILED>;
    try {
      await processEventOnce(this.redis, BOOKING_PAYMENT_EVENT_DEDUP, envelope.eventId, () =>
        // tripId = bookingId (opaco · §5.5). willRetry decide no-op (espera) vs CANCELADO permanente.
        this.bookings.handlePaymentFailed(tripId, willRetry),
      );
    } catch (err) {
      this.logger.error({ err, tripId, willRetry }, 'Falló el manejo de payment.failed en el booking');
      throw err;
    }
  }
}
