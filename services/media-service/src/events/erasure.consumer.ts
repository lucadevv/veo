/**
 * ErasureConsumer — derecho al olvido en media-service (Ley 29733, BR-S06).
 *
 * UN SOLO consumer Kafka para el group `media-service.erasure` que registra AMBOS eventos de la
 * cascada de borrado (regla de oro y esqueleto promovido: ver @veo/events/nest):
 *
 *  - `user.deleted` (identity-service, tombstone definitivo tras la gracia): purga la PII
 *    per-usuario que media-service custodia: el AVATAR del usuario (foto de la persona, key
 *    determinista por usuario en el bucket público).
 *    Degradación honesta — VIDEO DE CABINA: los segmentos (`media_segments`) se indexan por
 *    `tripId`, NO por usuario. media-service no conoce el mapa usuario→viajes (vive en
 *    trip-service) y no puede resolverlo sin un join cross-servicio (prohibido). Por eso el video
 *    NO se purga aquí: lo cierra `trip.pii_erased` (abajo) y el RetentionSweeper (BR-S03).
 *
 *  - `trip.pii_erased` (trip-service, UNO por viaje del usuario borrado): purga la grabación de
 *    ese viaje (objetos S3/MinIO + filas `media_segments` y sus solicitudes de acceso). Cierra el
 *    último hueco de la cascada `user.deleted` para el video de cabina.
 *
 * El ESQUELETO (bootstrap kafka + validar payload contra el registro central + dedup por eventId
 * con la marca DESPUÉS del éxito + logs + relanzar para que kafkajs reintente) vive promovido en
 * ErasureConsumerBase (@veo/events/nest); acá solo queda la config declarativa del dominio.
 * Idempotente: reprocesar es seguro (los borrados son no-op si ya no hay nada que borrar).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEnvelope } from '@veo/events';
import { ErasureConsumerBase, type ErasureHandlers } from '@veo/events/nest';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { AvatarService } from '../media/avatar.service';
import { RecordingService } from '../media/recording.service';
import { MEDIA_EVENT_DEDUP } from './dedup.options';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'media-service';

/** Group ÚNICO de erasure: todos sus topics los suscribe ESTE consumer (ver header). */
const ERASURE_GROUP_ID = 'media-service.erasure';

@Injectable()
export class ErasureConsumer extends ErasureConsumerBase {
  constructor(
    private readonly avatars: AvatarService,
    private readonly recording: RecordingService,
    @Inject(REDIS) redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    super(
      {
        clientId: KAFKA_CLIENT_ID,
        brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        groupId: ERASURE_GROUP_ID,
      },
      { redis, options: MEDIA_EVENT_DEDUP },
    );
  }

  /** Config del group de erasure: la LÓGICA de purga vive en Avatar/RecordingService (dominio). */
  protected override erasureHandlers(): ErasureHandlers {
    return {
      'user.deleted': {
        erase: async ({ userId }) => {
          const { deletedKeys } = await this.avatars.eraseUser(userId);
          return (
            `Derecho al olvido: avatar del usuario ${userId} purgado (${deletedKeys} key(s) tentadas). ` +
            'Video de cabina indexado por tripId: borrado gobernado por RetentionSweeper (BR-S03).'
          );
        },
        logError: ({ userId }) => ({
          context: { userId },
          message: 'No se pudo purgar el avatar del usuario borrado',
        }),
      },
      'trip.pii_erased': {
        erase: async ({ tripId }) => {
          const { purgedSegments } = await this.recording.eraseTrip(tripId);
          return `Derecho al olvido: video del viaje ${tripId} purgado (${purgedSegments} segmento(s)).`;
        },
        logError: ({ tripId }) => ({
          context: { tripId },
          message: 'No se pudo purgar el video del viaje borrado',
        }),
      },
    };
  }

  // Seams de los specs: invocan cada handler directo (sin Kafka) sobre el esqueleto promovido.
  private onUserDeleted(envelope: EventEnvelope<unknown>): Promise<void> {
    return this.processErasureEvent('user.deleted', envelope);
  }

  private onTripErased(envelope: EventEnvelope<unknown>): Promise<void> {
    return this.processErasureEvent('trip.pii_erased', envelope);
  }
}
