/**
 * AuditService — orquesta el registro inmutable y la verificación de integridad.
 * - record* construye el contenido y delega el append (hash chain) al repositorio.
 * - verifyRange recorre la cadena y detecta tampering (ver chain.ts).
 * La réplica WORM a S3 la realiza el relay (S3ReplicationRelay), desacoplado y resiliente.
 */
import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@veo/utils';
import type { EventEnvelope } from '@veo/events';
import { domainEventsTotal } from '@veo/observability';
import { AuditRepository, type AppendResult, type RecordedEntry } from './audit.repository';
import { verifyChain, type ChainVerificationResult } from './chain';

/** Datos de un registro síncrono (POST /audit o gRPC Record). */
export interface RecordSyncInput {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  ip: string;
  userAgent: string;
  occurredAt?: Date;
}

/** Mapeo de un evento de dominio consumido a una entrada de auditoría. */
export interface EventAuditMapping {
  actorId: string;
  resourceType: string;
  resourceId: string;
}

export interface VerifyRangeInput {
  fromSeq?: bigint;
  toSeq?: bigint;
}

export interface VerifyRangeResult extends ChainVerificationResult {
  fromSeq: string | null;
  toSeq: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly repo: AuditRepository) {}

  /** Registro síncrono iniciado por otro servicio (acción directa, no evento). */
  async recordSync(input: RecordSyncInput): Promise<RecordedEntry> {
    const result = await this.repo.appendEntry({
      eventId: uuidv7(),
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ip: input.ip,
      userAgent: input.userAgent,
      occurredAt: input.occurredAt ?? new Date(),
      payload: input.payload,
    });
    domainEventsTotal.inc({ event: input.action, result: 'recorded' });
    return result.entry;
  }

  /** Registro a partir de un evento de dominio consumido de Kafka. Idempotente por eventId. */
  async recordFromEvent(
    envelope: EventEnvelope<unknown>,
    topic: string,
    mapping: EventAuditMapping,
  ): Promise<AppendResult> {
    const result = await this.repo.appendEntry({
      eventId: envelope.eventId,
      actorId: mapping.actorId,
      action: envelope.eventType,
      resourceType: mapping.resourceType,
      resourceId: mapping.resourceId,
      ip: '',
      userAgent: `kafka:${topic}`,
      occurredAt: new Date(envelope.occurredAt),
      payload: (envelope.payload ?? {}) as Record<string, unknown>,
    });
    domainEventsTotal.inc({
      event: envelope.eventType,
      result: result.created ? 'recorded' : 'duplicate',
    });
    return result;
  }

  async query(filters: {
    resourceType?: string;
    resourceId?: string;
    actorId?: string;
    action?: string;
    limit: number;
    beforeSeq?: bigint;
  }): Promise<RecordedEntry[]> {
    return this.repo.query(filters);
  }

  /** Verifica la integridad de la cadena en un rango [fromSeq, toSeq]. */
  async verifyRange(input: VerifyRangeInput): Promise<VerifyRangeResult> {
    const rows = await this.repo.getRange(input.fromSeq, input.toSeq);
    const expectGenesis = input.fromSeq === undefined || input.fromSeq <= 1n;
    const result = verifyChain(rows, { expectGenesis });
    const first = rows[0];
    const last = rows[rows.length - 1];
    return {
      ...result,
      fromSeq: first ? String(first.seq) : null,
      toSeq: last ? String(last.seq) : null,
    };
  }
}
