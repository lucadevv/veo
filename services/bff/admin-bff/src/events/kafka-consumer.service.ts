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
import { LOGGER, type Logger } from '@veo/observability';
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
      };
    }

    // ── Conductores ──
    // El conductor MATERIALIZÓ su alta (primer paso del wizard de registro): lo sembramos en el read-model como
    // PENDIENTE para que aparezca en la vista de FLOTA ("Todos") DESDE el alta, no recién cuando hay una decisión
    // (verified/rejected). Cierra el hueco de que el read-model solo se sembraba con eventos de CAMBIO DE ESTADO:
    // la cola "Pendientes" ya veía a estos conductores (lee identity directo), pero la flota no. Espejo de
    // `driver.resubmitted` (también proyecta PENDING), pero originado en el registro. identity lo emite
    // exactly-once (solo quien gana la creación de la fila Driver); acá es idempotente igual (upsert por id, y el
    // watermark de status descarta una redelivery o un evento de estado posterior que llegara reordenado).
    record['driver.registered'] = async (e) => {
      const p = e.payload as EventPayload<'driver.registered'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        userId: p.userId,
        status: 'PENDING',
        backgroundCheckStatus: 'PENDING',
        updatedAt: p.registeredAt,
      });
    };
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
    };
    // El conductor RECHAZADO corrigió y reenvió a revisión (BR-I01): vuelve a PENDIENTE. Sin esto el
    // read-model quedaba stale en REJECTED mientras identity (detalle) ya decía PENDING (double-source).
    record['driver.resubmitted'] = async (e) => {
      const p = e.payload as EventPayload<'driver.resubmitted'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        userId: p.userId,
        status: 'PENDING',
        backgroundCheckStatus: 'PENDING',
        // Reenvío ⇒ ya no hay rechazo vigente: limpiamos el motivo.
        rejectionReason: null,
        updatedAt: p.resubmittedAt,
      });
    };
    record['driver.flagged'] = async (e) => {
      const p = e.payload as EventPayload<'driver.flagged'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        averageRating: p.rollingAvg,
        updatedAt: new Date().toISOString(),
      });
    };
    record['fleet.driver_suspended'] = async (e) => {
      const p = e.payload as EventPayload<'fleet.driver_suspended'>;
      // DOS VÍAS (Lote B): el evento llega keyeado por `driverId` (id de PERFIL → suspensión por DOCUMENTO),
      // o por `userId` (User.id → suspensión por INSPECCIÓN ITV; fleet no traduce a id de perfil). El
      // read-model de conductores está keyeado por el id de PERFIL Driver, así que SOLO podemos proyectar el
      // status cuando el evento trae `driverId`. Para la vía `userId`, resolver User.id → Driver.id exige una
      // lectura a identity que este consumer NO tiene cableada (el read-model no lleva PII ni índice inverso
      // userId→id). Residual ACEPTADO y acotado, MISMA clase que el watermark cross-service (ver
      // read-model.service.ts §upsertDriver): la AUTORIDAD del status es identity, y la vista de DETALLE del
      // panel YA lee `suspendedAt` de identity por gRPC (GetDriver) — la suspensión por ITV se VE ahí correcta.
      // Solo el badge de la LISTA no se voltea hasta el próximo evento de status. NO es un hueco de compliance
      // (el gate de turno vive en identity). Wirear la resolución en el consumer = initiative aparte.
      if (!p.driverId) {
        this.log.warn(
          { vehicleId: p.vehicleId, userId: p.userId },
          'fleet.driver_suspended por ITV (keyeado por userId): status NO proyectado al read-model (autoridad: identity). Detalle del panel correcto vía gRPC.',
        );
        return;
      }
      await this.readModel.upsertDriver({
        id: p.driverId,
        status: 'SUSPENDED',
        updatedAt: p.suspendedAt,
      });
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
    };
    // Reactivación MANUAL por un operador (la inversa de driver.suspended): saca al conductor de SUSPENDED
    // y lo proyecta de vuelta a ACTIVE (el mismo status post-aprobación que usa driver.verified). El
    // read-model solo guarda `status` (string) y NO conoce el estado pre-suspensión, por eso usamos ACTIVE.
    // Idempotente (upsert por id). Solo se emite para suspensiones DISCIPLINARY (fail-closed en identity).
    record['driver.reactivated'] = async (e) => {
      const p = e.payload as EventPayload<'driver.reactivated'>;
      await this.readModel.upsertDriver({
        id: p.driverId,
        status: 'ACTIVE',
        updatedAt: p.reactivatedAt,
      });
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
    };
    record['panic.acknowledged'] = async (e) => {
      const p = e.payload as EventPayload<'panic.acknowledged'>;
      this.gateway.emitPanicUpdate({ panicId: p.panicId, status: 'ACKNOWLEDGED', at: p.ackAt });
    };
    record['panic.resolved'] = async (e) => {
      const p = e.payload as EventPayload<'panic.resolved'>;
      this.gateway.emitPanicUpdate({ panicId: p.panicId, status: p.status, at: p.at });
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
}
