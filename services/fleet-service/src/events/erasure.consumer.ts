/**
 * ErasureConsumer — derecho al olvido en fleet-service (Ley 29733, BR-S06).
 *
 * Consume `user.deleted` (identity-service, tombstone definitivo tras la gracia) y purga la PII del
 * conductor que fleet custodia: sus VEHÍCULOS + los DOCUMENTOS de operador y de esos vehículos. Cierra
 * el hueco de la cascada de borrado que antes dejaba la flota del conductor HUÉRFANA — fleet no tenía
 * consumer de erasure (el HARD purge síncrono vía controller sí purga; la cascada async NO llegaba).
 *
 * OJO ids (fleet indexa con DOS ids distintos, por eso el evento trae ambos):
 *   - `Vehicle.driverId = User.id`           → se purga por `event.userId`.
 *   - `FleetDocument(DRIVER).ownerId = Driver.id` → se purga por `event.driverId`.
 * `purgeForDriver` usa cada uno donde corresponde (pasar userId a todo borraría 0 docs). Si el evento no
 * trae `driverId` (usuario sin perfil Driver), igual se purgan los vehículos por userId.
 *
 * El esqueleto (bootstrap kafka + validar payload + dedup por eventId + retry) vive en ErasureConsumerBase
 * (@veo/events/nest); acá queda solo la config declarativa del dominio. Idempotente: reprocesar es no-op.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErasureConsumerBase, type ErasureHandlers } from '@veo/events/nest';
import type { Redis } from '@veo/redis';
import { REDIS } from '../infra/redis';
import { VehiclesService } from '../vehicles/vehicles.service';
import { FLEET_EVENT_DEDUP } from './dedup.options';
import type { Env } from '../config/env.schema';

/** clientId kafkajs de este servicio. */
const KAFKA_CLIENT_ID = 'fleet-service';

/** Group ÚNICO de erasure de fleet (su único consumer Kafka hoy). */
const ERASURE_GROUP_ID = 'fleet-service.erasure';

@Injectable()
export class ErasureConsumer extends ErasureConsumerBase {
  constructor(
    private readonly vehicles: VehiclesService,
    @Inject(REDIS) redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    super(
      {
        clientId: KAFKA_CLIENT_ID,
        brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        groupId: ERASURE_GROUP_ID,
      },
      { redis, options: FLEET_EVENT_DEDUP },
    );
  }

  /** Config del group de erasure: la LÓGICA de purga vive en VehiclesService.purgeForDriver (dominio). */
  protected override erasureHandlers(): ErasureHandlers {
    return {
      'user.deleted': {
        erase: async ({ userId, driverId }) => {
          const purged = await this.vehicles.purgeForDriver({ userId, driverId });
          return (
            `Derecho al olvido: flota del conductor ${userId} purgada — ${purged.vehicles} vehículo(s), ` +
            `${purged.documents} doc(s) de operador, ${purged.vehicleDocuments} doc(s) de vehículo.`
          );
        },
        logError: ({ userId }) => ({
          context: { userId },
          message: 'No se pudo purgar la flota del conductor borrado',
        }),
      },
    };
  }
}
