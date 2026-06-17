/**
 * KafkaConsumerService — consume los topics de dominio y:
 *  1) proyecta el read-model CQRS (trips/drivers) usado por los listados,
 *  2) emite en tiempo real al gateway /ops (pánico con prioridad, viajes, ubicación).
 * Los payloads se validan con EVENT_SCHEMAS de @veo/events (lo hace KafkaEventConsumer al recibir).
 *
 * El BOOTSTRAP (createKafka + consumer del group + registro) vive promovido en
 * KafkaConsumerBootstrap (@veo/events/nest). Acá se conserva el LIFECYCLE propio del BFF:
 * arranque en onApplicationBootstrap SIN tumbar el proceso si Kafka no responde (el read-model y
 * el tiempo real degradan; las lecturas gRPC y comandos REST siguen funcionando).
 */
import { Injectable, Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type EventHandler, type EventPayload } from '@veo/events';
import { KafkaConsumerBootstrap } from '@veo/events/nest';
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

/** clientId kafkajs de este BFF. */
const KAFKA_CLIENT_ID = 'admin-bff';

@Injectable()
export class KafkaConsumerService extends KafkaConsumerBootstrap implements OnApplicationBootstrap {
  constructor(
    cfg: ConfigService<Env, true>,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly readModel: ReadModelService,
    private readonly gateway: OpsGateway,
  ) {
    super({
      clientId: KAFKA_CLIENT_ID,
      brokers: cfg
        .get('KAFKA_BROKERS', { infer: true })
        .split(',')
        .map((b) => b.trim()),
      groupId: cfg.get('KAFKA_CONSUMER_GROUP', { infer: true }),
    });
  }

  /** El arranque va en onApplicationBootstrap (lifecycle histórico del BFF), no acá. */
  override onModuleInit(): Promise<void> {
    return Promise.resolve();
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await super.onModuleInit();
    } catch (err) {
      // No tumbar el BFF si Kafka aún no está disponible: el read-model y el tiempo real degradan,
      // pero las lecturas gRPC y comandos REST siguen funcionando.
      this.log.error({ err }, 'no se pudo iniciar el consumidor Kafka');
    }
  }

  override async onModuleDestroy(): Promise<void> {
    try {
      await super.onModuleDestroy();
    } catch {
      // cierre best-effort
    }
  }

  protected override subscriptionLog(): string {
    return 'admin-bff consumiendo eventos (trip/panic/driver/fleet)';
  }

  /** TODOS los eventos del group, en un solo record (único punto de registro). */
  protected override handlers(): Readonly<Record<string, EventHandler>> {
    const record: Record<string, EventHandler> = {};

    // ── Viajes ──
    record['trip.requested'] = async (e) => {
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
    };
    for (const type of [
      'trip.assigned',
      'trip.accepted',
      'trip.arriving',
      'trip.arrived',
      'trip.started',
      'trip.completed',
      'trip.cancelled',
    ] as const) {
      record[type] = async (e) => {
        const status = TRIP_STATUS_BY_EVENT[type];
        if (!status) return;
        const p = e.payload as { tripId: string; driverId?: string; etaSeconds?: number };
        await this.readModel.patchTrip(p.tripId, status, p.driverId);
        this.emitTrip(p.tripId, status, p.etaSeconds ?? null, e.occurredAt);
        this.counted(type);
      };
    }

    // ── Conductores ──
    record['driver.verified'] = async (e) => {
      const p = e.payload as EventPayload<'driver.verified'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        userId: p.userId,
        status: 'ACTIVE',
        backgroundCheckStatus: 'CLEARED',
        // Aprobado ⇒ ya no hay rechazo vigente: limpiamos el motivo (null explícito).
        rejectionReason: null,
        updatedAt: p.verifiedAt,
      });
      this.counted('driver.verified');
    };
    record['driver.rejected'] = async (e) => {
      const p = e.payload as EventPayload<'driver.rejected'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        userId: p.userId,
        status: 'REJECTED',
        backgroundCheckStatus: 'REJECTED',
        // "" (operador sin motivo) → null honesto; el panel muestra "sin motivo" en vez de un texto falso.
        rejectionReason: p.reason ? p.reason : null,
        updatedAt: p.rejectedAt,
      });
      this.counted('driver.rejected');
    };
    record['driver.flagged'] = async (e) => {
      const p = e.payload as EventPayload<'driver.flagged'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        averageRating: p.rollingAvg,
        updatedAt: new Date().toISOString(),
      });
      this.counted('driver.flagged');
    };
    record['fleet.driver_suspended'] = async (e) => {
      const p = e.payload as EventPayload<'fleet.driver_suspended'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        status: 'SUSPENDED',
        updatedAt: p.suspendedAt,
      });
      this.counted('fleet.driver_suspended');
    };
    // Suspensión MANUAL por un operador admin (espejo de fleet.driver_suspended, pero originada en el panel):
    // proyecta status=SUSPENDED para que la lista de conductores lo refleje. Idempotente (upsert por id).
    record['driver.suspended'] = async (e) => {
      const p = e.payload as EventPayload<'driver.suspended'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        status: 'SUSPENDED',
        updatedAt: p.suspendedAt,
      });
      this.counted('driver.suspended');
    };
    record['driver.location_updated'] = async (e) => {
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
    };

    // ── Pánico (prioridad) ──
    record['panic.triggered'] = async (e) => {
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
    };
    record['panic.acknowledged'] = async (e) => {
      const p = e.payload as EventPayload<'panic.acknowledged'>;
      this.gateway.emitPanicUpdate({ panicId: p.panicId, status: 'ACKNOWLEDGED', at: p.ackAt });
      this.counted('panic.acknowledged');
    };
    record['panic.resolved'] = async (e) => {
      const p = e.payload as EventPayload<'panic.resolved'>;
      this.gateway.emitPanicUpdate({ panicId: p.panicId, status: p.status, at: p.at });
      this.counted('panic.resolved');
    };

    return record;
  }

  private emitTrip(
    tripId: string,
    status: TripStatus,
    etaSeconds: number | null,
    at: string,
  ): void {
    this.gateway.emitTripUpdate({ tripId, status, etaSeconds, driverLocation: null, at });
  }

  private counted(event: string): void {
    domainEventsTotal.inc({ event, result: 'consumed' });
  }
}
