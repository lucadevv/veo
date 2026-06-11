/**
 * Consumidor Kafka de `user.deleted` → anonimiza la PII de localización de los viajes del usuario
 * (BR-S06 derecho al olvido, Ley 29733). identity-service emite este evento cuando el sweeper
 * aplica el tombstone definitivo tras la gracia; aquí materializamos la cascada de borrado.
 *
 * Conserva la fila del viaje (auditoría/finanzas) y borra coordenadas precisas + ruta.
 *
 * El ESQUELETO (bootstrap kafka + validar payload contra el registro central + logs + relanzar
 * para que kafkajs reintente) vive promovido en ErasureConsumerBase (@veo/events/nest); acá solo
 * queda la config declarativa del dominio. SIN dedup Redis: la anonimización es una
 * sobre-escritura determinista, reprocesar el evento es un no-op (idempotente por construcción).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEnvelope } from '@veo/events';
import { ErasureConsumerBase, type ErasureHandlers } from '@veo/events/nest';
import { TripsService } from './trips.service';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'trip-service';

/** Group ÚNICO de erasure: todos sus topics los suscribe ESTE consumer (@veo/events/nest). */
const ERASURE_GROUP_ID = 'trip-service.erasure';

@Injectable()
export class UserDeletedConsumer extends ErasureConsumerBase {
  constructor(
    private readonly trips: TripsService,
    config: ConfigService<Env, true>,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: ERASURE_GROUP_ID,
    });
  }

  /** Config del group de erasure: la LÓGICA de anonimización vive en TripsService (dominio). */
  protected override erasureHandlers(): ErasureHandlers {
    return {
      'user.deleted': {
        // El pasajero del viaje es el usuario borrado (passengerId === userId de identity).
        erase: async ({ userId }) => {
          await this.trips.anonymizePassenger(userId);
        },
        logError: ({ userId }) => ({
          context: { userId },
          message: 'No se pudo anonimizar los viajes del usuario borrado',
        }),
      },
    };
  }

  // Seam de los specs: invoca el handler directo (sin Kafka) sobre el esqueleto promovido.
  private onUserDeleted(envelope: EventEnvelope<unknown>): Promise<void> {
    return this.processErasureEvent('user.deleted', envelope);
  }
}
