/**
 * KafkaConsumerService — consume los topics de dominio y:
 *  1) proyecta el read-model CQRS (trips/drivers) usado por los listados,
 *  2) emite en tiempo real al gateway /ops (pánico con prioridad, viajes, ubicación).
 * Los payloads se validan con EVENT_SCHEMAS de @veo/events (lo hace KafkaEventConsumer al recibir).
 */
import {
  Injectable,
  Inject,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createKafka, KafkaEventConsumer, type EventPayload } from '@veo/events';
import { LOGGER, type Logger, domainEventsTotal } from '@veo/observability';
import type { TripStatus } from '@veo/api-client';
import type { Env } from '../config/env.schema';
import { ReadModelService } from '../read-model/read-model.service';
import { OpsGateway } from '../gateway/ops.gateway';

/** Estado api-client derivado del tipo de evento de viaje. */
const TRIP_STATUS_BY_EVENT: Record<string, TripStatus> = {
  'trip.requested': 'REQUESTED',
  'trip.assigned': 'ASSIGNED',
  'trip.accepted': 'ACCEPTED',
  'trip.arriving': 'ARRIVING',
  'trip.arrived': 'ARRIVED',
  'trip.started': 'IN_PROGRESS',
  'trip.completed': 'COMPLETED',
  'trip.cancelled': 'CANCELLED',
};

@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private consumer?: KafkaEventConsumer;

  constructor(
    private readonly cfg: ConfigService<Env, true>,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly readModel: ReadModelService,
    private readonly gateway: OpsGateway,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const brokers = this.cfg.get('KAFKA_BROKERS', { infer: true }).split(',').map((b) => b.trim());
    const kafka = createKafka({
      clientId: 'admin-bff',
      brokers,
      groupId: this.cfg.get('KAFKA_CONSUMER_GROUP', { infer: true }),
    });
    const consumer = new KafkaEventConsumer(kafka, this.cfg.get('KAFKA_CONSUMER_GROUP', { infer: true }));

    // ── Viajes ──
    consumer.on('trip.requested', async (e) => {
      const p = e.payload as EventPayload<'trip.requested'>;
      await this.readModel.upsertTrip({
        id: p.tripId,
        status: 'REQUESTED',
        passengerId: p.passengerId,
        driverId: null,
        fareCents: p.fareCents,
        createdAt: e.occurredAt,
      });
      this.emitTrip(p.tripId, 'REQUESTED', null, e.occurredAt);
      this.counted('trip.requested');
    });
    for (const type of [
      'trip.assigned',
      'trip.accepted',
      'trip.arriving',
      'trip.arrived',
      'trip.started',
      'trip.completed',
      'trip.cancelled',
    ] as const) {
      consumer.on(type, async (e) => {
        const status = TRIP_STATUS_BY_EVENT[type];
        if (!status) return;
        const p = e.payload as { tripId: string; driverId?: string; etaSeconds?: number };
        await this.readModel.patchTrip(p.tripId, status, p.driverId);
        this.emitTrip(p.tripId, status, p.etaSeconds ?? null, e.occurredAt);
        this.counted(type);
      });
    }

    // ── Conductores ──
    consumer.on('driver.verified', async (e) => {
      const p = e.payload as EventPayload<'driver.verified'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        userId: p.userId,
        status: 'ACTIVE',
        backgroundCheckStatus: 'CLEARED',
        updatedAt: p.verifiedAt,
      });
      this.counted('driver.verified');
    });
    consumer.on('driver.flagged', async (e) => {
      const p = e.payload as EventPayload<'driver.flagged'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        averageRating: p.rollingAvg,
        updatedAt: new Date().toISOString(),
      });
      this.counted('driver.flagged');
    });
    consumer.on('fleet.driver_suspended', async (e) => {
      const p = e.payload as EventPayload<'fleet.driver_suspended'>;
      await this.readModel.upsertDriver({ id: p.driverId, status: 'SUSPENDED', updatedAt: p.suspendedAt });
      this.counted('fleet.driver_suspended');
    });
    consumer.on('driver.location_updated', async (e) => {
      const p = e.payload as EventPayload<'driver.location_updated'>;
      this.gateway.emitDriverLocation({
        tripId: '',
        driverId: p.driverId,
        point: p.point,
        heading: null,
        speedKph: null,
        at: p.at,
      });
      this.counted('driver.location_updated');
    });

    // ── Pánico (prioridad) ──
    consumer.on('panic.triggered', async (e) => {
      const p = e.payload as EventPayload<'panic.triggered'>;
      this.gateway.emitPanicAlert({
        panicId: p.panicId,
        tripId: p.tripId,
        passengerId: p.passengerId,
        geo: p.geo,
        status: 'TRIGGERED',
        triggeredAt: p.triggeredAt,
      });
      this.counted('panic.triggered');
    });
    consumer.on('panic.acknowledged', async (e) => {
      const p = e.payload as EventPayload<'panic.acknowledged'>;
      this.gateway.emitPanicUpdate({ panicId: p.panicId, status: 'ACKNOWLEDGED', at: p.ackAt });
      this.counted('panic.acknowledged');
    });
    consumer.on('panic.resolved', async (e) => {
      const p = e.payload as EventPayload<'panic.resolved'>;
      this.gateway.emitPanicUpdate({ panicId: p.panicId, status: p.status, at: p.at });
      this.counted('panic.resolved');
    });

    this.consumer = consumer;
    try {
      await consumer.start();
      this.logger.info('admin-bff consumiendo eventos (trip/panic/driver/fleet)');
    } catch (err) {
      // No tumbar el BFF si Kafka aún no está disponible: el read-model y el tiempo real degradan,
      // pero las lecturas gRPC y comandos REST siguen funcionando.
      this.logger.error({ err }, 'no se pudo iniciar el consumidor Kafka');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.consumer) {
      try {
        await this.consumer.stop();
      } catch {
        // cierre best-effort
      }
    }
  }

  private emitTrip(tripId: string, status: TripStatus, etaSeconds: number | null, at: string): void {
    this.gateway.emitTripUpdate({ tripId, status, etaSeconds, driverLocation: null, at });
  }

  private counted(event: string): void {
    domainEventsTotal.inc({ event, result: 'consumed' });
  }
}
