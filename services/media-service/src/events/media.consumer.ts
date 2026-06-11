/**
 * MediaEventConsumer — consume los eventos de dominio que disparan la grabación (BR-S01).
 *
 *  - `trip.started`     → inicia grabación + publica `media.recording_started`.
 *  - `trip.completed`   → finaliza grabación + publica `media.archived`.
 *  - `panic.triggered`  → fuerza grabación (aunque el viaje no esté IN_PROGRESS) y fija retención
 *                         indefinida (BR-S01 excepción + BR-S03).
 *
 * El BOOTSTRAP (createKafka + consumer del group + lifecycle + log de suscripción derivado del
 * registro) vive promovido en KafkaConsumerBootstrap (@veo/events/nest); regla de oro: un groupId
 * = UN consumer con TODOS sus eventos en `handlers()`.
 *
 * Valida el payload contra el registro central (@veo/events) y descarta lo inválido. Deduplica por
 * `eventId` en Redis con la marca DESPUÉS del éxito (at-least-once): si un handler falla, el dedup
 * NO se escribe y kafkajs reintenta sin perder el evento — un `panic.triggered` jamás se descarta
 * por un fallo transitorio. Reprocesar es seguro: los handlers de RecordingService son idempotentes
 * (segmento abierto por viaje / finish no-op / update al mismo valor).
 *
 * POR QUÉ NO ErasureConsumerBase (aunque `handle()` sea casi-gemelo de su esqueleto): su contrato
 * declarativo pasa SOLO el payload parseado a `erase(payload)` y `logError(payload)`, y este
 * consumer necesita el ENVELOPE — `trip.completed` usa `envelope.occurredAt` como fin de la
 * grabación y los logs operativos llevan `envelope.eventId` (trazar un evento de pánico concreto).
 * Además sus textos fijos son de erasure ("…(derecho al olvido)", "…; ignorado") y estos eventos
 * no son una cascada de borrado. Adaptar la base para esto la acoplaría a un caso que no es suyo;
 * si aparece un tercer consumer con este shape (validar+dedup post-éxito+envelope), promover
 * entonces un esqueleto genérico a @veo/events/nest.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { processEventOnce, schemaForEvent, type EventEnvelope, type EventHandler } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { RecordingService } from '../media/recording.service';
import { MEDIA_EVENT_DEDUP } from './dedup.options';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'media-service';

/** Group principal de media-service (grabación); el de erasure es otro group (erasure.consumer). */
const MEDIA_GROUP_ID = 'media-service';

@Injectable()
export class MediaEventConsumer extends KafkaConsumerBootstrap {
  constructor(
    private readonly recording: RecordingService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: MEDIA_GROUP_ID,
    });
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    return {
      'trip.started': (e) => this.handle(e, (env) => this.onTripStarted(env)),
      'trip.completed': (e) => this.handle(e, (env) => this.onTripCompleted(env)),
      'panic.triggered': (e) => this.handle(e, (env) => this.onPanicTriggered(env)),
    };
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    return `Consumiendo ${eventTypes.join(', ')}`;
  }

  /** Valida payload + delega con dedup por eventId marcado DESPUÉS del éxito. */
  private async handle(
    envelope: EventEnvelope<unknown>,
    fn: (envelope: EventEnvelope<unknown>) => Promise<void>,
  ): Promise<void> {
    const schema = schemaForEvent(envelope.eventType);
    if (schema) {
      const parsed = schema.safeParse(envelope.payload);
      if (!parsed.success) {
        this.logger.warn(`Payload inválido para ${envelope.eventType} (eventId=${envelope.eventId})`);
        return;
      }
    }
    try {
      // Mismo esqueleto que ErasureConsumer: el dedup se marca DESPUÉS de procesar con éxito.
      // Un fallo deja que kafkajs reintente sin perder el evento.
      await processEventOnce(this.redis, MEDIA_EVENT_DEDUP, envelope.eventId, () => fn(envelope));
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, el reintento volverá a procesar.
      this.logger.error(
        { err, eventType: envelope.eventType },
        `No se pudo procesar ${envelope.eventType} (eventId=${envelope.eventId}); kafkajs reintentará`,
      );
      throw err;
    }
  }

  private async onTripStarted(envelope: EventEnvelope<unknown>): Promise<void> {
    const payload = envelope.payload as { tripId: string; startedAt: string };
    await this.recording.startForTrip(payload.tripId, new Date(payload.startedAt));
  }

  private async onTripCompleted(envelope: EventEnvelope<unknown>): Promise<void> {
    const payload = envelope.payload as { tripId: string };
    await this.recording.finishForTrip(payload.tripId, new Date(envelope.occurredAt));
  }

  private async onPanicTriggered(envelope: EventEnvelope<unknown>): Promise<void> {
    const payload = envelope.payload as { tripId: string; triggeredAt: string };
    await this.recording.onPanic(payload.tripId, new Date(payload.triggeredAt));
  }
}
