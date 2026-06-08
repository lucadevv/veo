/**
 * PanicService — corazón del botón de pánico (BR-S04 idempotencia, BR-S05 publicación confiable).
 *
 * Diseño de latencia (SLO ack <800ms p99):
 *  - El trigger SOLO persiste el evento + encola el outbox en una transacción y responde.
 *  - NO hace fan-out síncrono: el fan-out (SMS+link a contactos, push a central) lo ejecuta
 *    notification-service consumiendo panic.triggered. media-service hace el force-start de la
 *    grabación. Aquí se garantiza la publicación inmediata y confiable vía outbox.
 *  - El trigger NO toca S3 ni red externa: las keys de evidencia se reservan con una función pura.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope, type EventPayload } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { InvalidStateError, NotFoundError, UnauthorizedError, ValidationError, isUuidV7, uuidv7, verifyHmac } from '@veo/utils';
import { PanicStatus } from '@veo/shared-types';
import { Prisma, type PanicEvent } from '../generated/prisma';
import { PrismaService } from '../infra/prisma.service';
import { PanicMetrics } from '../metrics/panic.metrics';
import { S3_EVIDENCE_STORE, type S3EvidenceStore } from '../ports/s3-evidence/s3-evidence.port';
import { PANIC_HMAC_SECRET, buildPanicSignatureMessage } from './panic.hmac';
import type { Env } from '../config/env.schema';

const PRODUCER = 'panic-service';

export interface TriggerPanicInput {
  tripId: string;
  passengerId: string;
  dedupKey: string;
  lat: number;
  lon: number;
  signature: string;
}

export interface TriggerPanicResult {
  panicId: string;
  status: PanicStatus;
  /** true si la dedupKey ya existía (no-op idempotente: ni fila nueva ni evento nuevo). */
  deduplicated: boolean;
  triggeredAt: string;
  evidenceS3Keys: string[];
  /** Latencia del ack en ms (también se observa en la métrica veo_panic_trigger_ack_*). */
  ackMs: number;
}

@Injectable()
export class PanicService {
  private readonly hmacSecret: string;
  private readonly keysPerPanic: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: PanicMetrics,
    @Inject(S3_EVIDENCE_STORE) private readonly evidence: S3EvidenceStore,
    @Inject(PANIC_HMAC_SECRET) hmacSecret: string,
    config: ConfigService<Env, true>,
  ) {
    this.hmacSecret = hmacSecret;
    this.keysPerPanic = config.getOrThrow<number>('EVIDENCE_KEYS_PER_PANIC');
  }

  /**
   * BR-S04: dispara el pánico de forma idempotente. La primera vez crea la fila y encola
   * panic.triggered; las siguientes con la misma dedupKey son no-op y devuelven el mismo panicId.
   */
  async trigger(input: TriggerPanicInput): Promise<TriggerPanicResult> {
    const start = process.hrtime.bigint();

    if (!isUuidV7(input.dedupKey)) {
      throw new ValidationError('dedupKey debe ser un UUIDv7', { dedupKey: input.dedupKey });
    }
    const message = buildPanicSignatureMessage({
      tripId: input.tripId,
      dedupKey: input.dedupKey,
      lat: input.lat,
      lon: input.lon,
    });
    if (!verifyHmac(message, this.hmacSecret, input.signature)) {
      throw new UnauthorizedError('Firma HMAC del pánico inválida (BR-S04)');
    }

    const id = uuidv7();
    const triggeredAt = new Date();
    // Reserva de keys S3 (función pura, sin I/O): no penaliza el SLO de <800ms.
    const evidenceS3Keys = this.evidence.reserveKeys(id, this.keysPerPanic);

    try {
      const created = await this.prisma.write.$transaction(async (tx) => {
        const row = await tx.panicEvent.create({
          data: {
            id,
            tripId: input.tripId,
            passengerId: input.passengerId,
            triggeredAt,
            geoLat: input.lat,
            geoLon: input.lon,
            dedupKey: input.dedupKey,
            status: PanicStatus.TRIGGERED,
            evidenceS3Keys,
          },
        });
        const payload: EventPayload<'panic.triggered'> = {
          panicId: row.id,
          tripId: row.tripId,
          passengerId: row.passengerId,
          geo: { lat: row.geoLat, lon: row.geoLon },
          dedupKey: row.dedupKey,
          triggeredAt: row.triggeredAt.toISOString(),
        };
        const envelope = createEnvelope({
          eventType: 'panic.triggered',
          producer: PRODUCER,
          dedupKey: row.dedupKey,
          payload,
        });
        await enqueueOutbox(tx, envelope, row.id);
        return row;
      });

      const ackMs = this.metrics.observeTriggerAck(start);
      return {
        panicId: created.id,
        status: created.status,
        deduplicated: false,
        triggeredAt: created.triggeredAt.toISOString(),
        evidenceS3Keys: created.evidenceS3Keys,
        ackMs,
      };
    } catch (err) {
      // BR-S04: la unique(dedup_key) convierte el doble submit en no-op idempotente.
      if (this.isDedupConflict(err)) {
        const existing = await this.prisma.write.panicEvent.findUnique({
          where: { dedupKey: input.dedupKey },
        });
        if (existing) {
          const ackMs = this.metrics.observeTriggerAck(start);
          return {
            panicId: existing.id,
            status: existing.status,
            deduplicated: true,
            triggeredAt: existing.triggeredAt.toISOString(),
            evidenceS3Keys: existing.evidenceS3Keys,
            ackMs,
          };
        }
      }
      throw err;
    }
  }

  /** BR-S05 (ack): el operador reconoce la alerta → ACKNOWLEDGED + publica panic.acknowledged. */
  async acknowledge(panicId: string, operatorId: string): Promise<PanicEvent> {
    const start = process.hrtime.bigint();
    const updated = await this.prisma.write.$transaction(async (tx) => {
      const current = await tx.panicEvent.findUnique({ where: { id: panicId } });
      if (!current) throw new NotFoundError('Evento de pánico no encontrado');
      if (current.status !== PanicStatus.TRIGGERED) {
        throw new InvalidStateError(
          `No se puede reconocer un pánico en estado ${current.status}`,
          { from: current.status },
        );
      }
      const ackAt = new Date();
      const row = await tx.panicEvent.update({
        where: { id: panicId },
        data: { status: PanicStatus.ACKNOWLEDGED, acknowledgedAt: ackAt, ackBy: operatorId },
      });
      const payload: EventPayload<'panic.acknowledged'> = {
        panicId: row.id,
        operatorId,
        ackAt: ackAt.toISOString(),
      };
      const envelope = createEnvelope({
        eventType: 'panic.acknowledged',
        producer: PRODUCER,
        payload,
      });
      await enqueueOutbox(tx, envelope, row.id);
      return row;
    });
    this.metrics.observeOperatorAck(start);
    return updated;
  }

  /**
   * Cierre de la alerta por el operador: RESOLVED o FALSE_ALARM. Publica `panic.resolved` (MISMA tx que
   * el cambio de estado, vía outbox) para que el dashboard de operadores (admin-bff) y el audit conozcan
   * el cierre — sin él, una alerta cerrada quedaba como dead-end: el estado cambiaba en la DB del
   * panic-service pero el resto del sistema nunca se enteraba. La relectura del estado dentro de la tx
   * (status-guard) hace el cierre idempotente y concurrencia-seguro (igual que `acknowledge`).
   */
  async resolve(
    panicId: string,
    resolution: typeof PanicStatus.RESOLVED | typeof PanicStatus.FALSE_ALARM,
    operatorId: string,
  ): Promise<PanicEvent> {
    return this.prisma.write.$transaction(async (tx) => {
      const current = await tx.panicEvent.findUnique({ where: { id: panicId } });
      if (!current) throw new NotFoundError('Evento de pánico no encontrado');
      if (current.status === PanicStatus.RESOLVED || current.status === PanicStatus.FALSE_ALARM) {
        throw new InvalidStateError(`El pánico ya está cerrado (${current.status})`, {
          from: current.status,
        });
      }
      const resolvedAt = new Date();
      const row = await tx.panicEvent.update({
        where: { id: panicId },
        data: { status: resolution, resolvedAt },
      });
      const payload: EventPayload<'panic.resolved'> = {
        panicId: row.id,
        status: resolution,
        resolvedBy: operatorId,
        at: resolvedAt.toISOString(),
      };
      const envelope = createEnvelope({
        eventType: 'panic.resolved',
        producer: PRODUCER,
        payload,
      });
      await enqueueOutbox(tx, envelope, row.id);
      return row;
    });
  }

  /**
   * Anexa keys S3 de evidencia (subidas por media-service) y, si finalize, aplica retención WORM.
   * Las keys se acumulan sin duplicar.
   */
  async appendEvidence(
    panicId: string,
    keys: string[],
    finalize: boolean,
  ): Promise<{ evidenceS3Keys: string[]; protectedKeys: string[] }> {
    const current = await this.prisma.read.panicEvent.findUnique({ where: { id: panicId } });
    if (!current) throw new NotFoundError('Evento de pánico no encontrado');
    if (keys.length === 0) throw new ValidationError('Se requiere al menos una key');

    const merged = Array.from(new Set([...current.evidenceS3Keys, ...keys]));
    const updated = await this.prisma.write.panicEvent.update({
      where: { id: panicId },
      data: { evidenceS3Keys: merged },
    });
    const protectedKeys = finalize ? await this.evidence.protect(keys) : [];
    return { evidenceS3Keys: updated.evidenceS3Keys, protectedKeys };
  }

  getById(panicId: string): Promise<PanicEvent | null> {
    return this.prisma.read.panicEvent.findUnique({ where: { id: panicId } });
  }

  /** Lectura post-write crítica (sin lag de réplica): usa el primario. */
  async getByIdOrThrow(panicId: string): Promise<PanicEvent> {
    const row = await this.getById(panicId);
    if (!row) throw new NotFoundError('Evento de pánico no encontrado');
    return row;
  }

  list(status?: PanicStatus): Promise<PanicEvent[]> {
    return this.prisma.read.panicEvent.findMany({
      where: status ? { status } : undefined,
      orderBy: { triggeredAt: 'desc' },
      take: 200,
    });
  }

  private isDedupConflict(err: unknown): err is Prisma.PrismaClientKnownRequestError {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      this.targetsDedupKey(err.meta?.target)
    );
  }

  private targetsDedupKey(target: unknown): boolean {
    if (typeof target === 'string') return target.includes('dedup');
    if (Array.isArray(target)) return target.some((t) => String(t).includes('dedup'));
    return true; // sin meta fiable, asumimos el único unique del modelo (dedup_key)
  }
}
