/**
 * AuditConsumer — consume los eventos auditables del dominio VEO y los registra de forma
 * inmutable (hash chain). Idempotente por envelope.eventId. audit-service principalmente CONSUME.
 *
 * Cobertura actual (eventos definidos en @veo/events · EVENT_SCHEMAS):
 *  - Identidad/KYC: user.registered, driver.verified, biometric.failed
 *  - Derecho al olvido (BR-S06): user.deletion_requested, user.deleted
 *  - Pánico:        panic.triggered, panic.acknowledged
 *  - Pagos:         payment.captured, payment.failed, payout.processed
 *  - Video/Media:   media.recording_started, media.archived
 *
 * Contratos AÚN no disponibles en @veo/events (ver README · "contratos pendientes"):
 *  - Acceso a video por operador (p.ej. media.accessed) desde media-service.
 *  - Cambios RBAC (p.ej. admin.role_changed / rbac.changed) desde identity-service.
 */
import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createKafka,
  KafkaEventConsumer,
  topicForEvent,
  EVENT_SCHEMAS,
  type EventType,
  type EventPayload,
} from '@veo/events';
import { AuditService, type EventAuditMapping } from '../audit/audit.service';
import type { Env } from '../config/env.schema';

@Injectable()
export class AuditConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AuditConsumer.name);
  private readonly consumer: KafkaEventConsumer;
  private readonly fromBeginning: boolean;

  constructor(
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    const kafka = createKafka({
      clientId: 'audit-service',
      brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
      groupId: config.getOrThrow<string>('KAFKA_GROUP_ID'),
    });
    this.consumer = new KafkaEventConsumer(kafka, config.getOrThrow<string>('KAFKA_GROUP_ID'));
    this.fromBeginning = config.getOrThrow<boolean>('KAFKA_FROM_BEGINNING');
    this.registerHandlers();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.consumer.start(this.fromBeginning);
      this.logger.log('Consumidor de eventos auditables iniciado');
    } catch (err) {
      this.logger.error({ err }, 'No se pudo iniciar el consumidor de Kafka');
      throw err;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }

  private registerHandlers(): void {
    // Identidad / KYC
    this.register('user.registered', (p) => ({
      actorId: p.userId,
      resourceType: 'user',
      resourceId: p.userId,
    }));
    this.register('driver.verified', (p) => ({
      actorId: p.driverId,
      resourceType: 'driver',
      resourceId: p.driverId,
    }));
    this.register('biometric.failed', (p) => ({
      actorId: p.driverId,
      resourceType: 'driver',
      resourceId: p.driverId,
    }));

    // Derecho al olvido (BR-S06 · Ley 29733): traza inmutable de cada etapa del borrado.
    // user.deletion_requested = solicitud (inicia la gracia); user.deleted = borrado efectivo (sweep).
    this.register('user.deletion_requested', (p) => ({
      actorId: p.userId,
      resourceType: 'user',
      resourceId: p.userId,
    }));
    this.register('user.deleted', (p) => ({
      actorId: p.userId,
      resourceType: 'user',
      resourceId: p.userId,
    }));

    // Pánico
    this.register('panic.triggered', (p) => ({
      actorId: p.passengerId,
      resourceType: 'panic',
      resourceId: p.panicId,
    }));
    this.register('panic.acknowledged', (p) => ({
      actorId: p.operatorId,
      resourceType: 'panic',
      resourceId: p.panicId,
    }));

    // Pagos
    this.register('payment.captured', (p) => ({
      actorId: 'system',
      resourceType: 'payment',
      resourceId: p.paymentId,
    }));
    this.register('payment.failed', (p) => ({
      actorId: 'system',
      resourceType: 'payment',
      resourceId: p.paymentId,
    }));
    this.register('payout.processed', (p) => ({
      actorId: p.driverId,
      resourceType: 'payout',
      resourceId: p.payoutId,
    }));

    // Video / Media (ciclo de vida de la grabación · BR-S01)
    this.register('media.recording_started', (p) => ({
      actorId: 'system',
      resourceType: 'media',
      resourceId: p.tripId,
    }));
    this.register('media.archived', (p) => ({
      actorId: 'system',
      resourceType: 'media',
      resourceId: p.tripId,
    }));
  }

  /** Registra un handler tipado para un eventType y mapea su payload a una entrada de auditoría. */
  private register<T extends EventType>(
    type: T,
    map: (payload: EventPayload<T>) => EventAuditMapping,
  ): void {
    const schema = EVENT_SCHEMAS[type];
    this.consumer.on(type, async (envelope) => {
      const payload = schema.parse(envelope.payload) as EventPayload<T>;
      try {
        await this.audit.recordFromEvent(envelope, topicForEvent(type), map(payload));
      } catch (err) {
        this.logger.error({ err, eventType: type, eventId: envelope.eventId }, 'fallo al auditar evento');
        throw err;
      }
    });
  }
}
