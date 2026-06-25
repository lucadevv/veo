/**
 * AuditRepository — acceso append-only al audit log.
 * El append es serializado con un advisory lock transaccional de Postgres para garantizar
 * orden estricto de la cadena (seq) y que prevHash sea SIEMPRE el hash de la última entrada,
 * incluso con writers concurrentes. NO expone update/delete (append-only).
 */
import { Injectable } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { uuidv7 } from '@veo/utils';
import { computeEntryHash, type AuditEntryContent, type ChainRow } from './chain';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';

/** Clave fija del advisory lock que serializa el append de la cadena. */
const APPEND_LOCK_KEY = 4951;

export interface RecordedEntry {
  id: string;
  seq: bigint;
  eventId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  ip: string;
  userAgent: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
  s3ObjectKey: string | null;
  createdAt: Date;
}

export interface AppendResult {
  entry: RecordedEntry;
  /** false si el eventId ya existía (idempotencia): no se insertó nada nuevo. */
  created: boolean;
}

export interface QueryFilters {
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  action?: string;
  limit: number;
  /** Cursor: devolver entradas con seq < beforeSeq (paginación descendente). */
  beforeSeq?: bigint;
}

interface AuditLogRow {
  id: string;
  seq: bigint;
  eventId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  ip: string;
  userAgent: string;
  occurredAt: Date;
  payload: Prisma.JsonValue;
  prevHash: string | null;
  hash: string;
  s3ObjectKey: string | null;
  createdAt: Date;
}

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserta una entrada al final de la cadena. Idempotente por `eventId`.
   * Encola `audit.recorded` en el outbox dentro de la misma transacción.
   */
  async appendEntry(content: AuditEntryContent): Promise<AppendResult> {
    return this.prisma.write.$transaction(async (tx) => {
      // Serializa el append: solo un writer calcula prevHash/seq a la vez.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${APPEND_LOCK_KEY})`;

      const existing = await tx.auditLog.findUnique({ where: { eventId: content.eventId } });
      if (existing) {
        return { entry: toRecorded(existing), created: false };
      }

      const last = await tx.auditLog.findFirst({ orderBy: { seq: 'desc' } });
      const prevHash = last?.hash ?? null;
      const hash = computeEntryHash(prevHash, content);
      const id = uuidv7();

      const created = await tx.auditLog.create({
        data: {
          id,
          eventId: content.eventId,
          actorId: content.actorId,
          action: content.action,
          resourceType: content.resourceType,
          resourceId: content.resourceId,
          ip: content.ip,
          userAgent: content.userAgent,
          occurredAt: new Date(content.occurredAt),
          payload: content.payload as Prisma.InputJsonValue,
          prevHash,
          hash,
        },
      });

      const envelope = createEnvelope({
        eventType: 'audit.recorded',
        producer: 'audit-service',
        occurredAt: new Date(content.occurredAt).toISOString(),
        payload: {
          // Alineado al schema `auditRecorded` de @veo/events: `entryId` (no `auditId`) + `at` OBLIGATORIO.
          // Antes faltaban ambos → el relay marcaba el evento POISON en cada auditoría (payload inválido).
          entryId: created.id,
          seq: String(created.seq),
          eventId: created.eventId,
          // actorId es opcional en el schema (z.string().optional()); la fila puede tenerlo null → undefined.
          actorId: created.actorId ?? undefined,
          action: created.action,
          resourceType: created.resourceType,
          resourceId: created.resourceId,
          at: created.createdAt.toISOString(),
          hash: created.hash,
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: created.resourceId,
          eventType: 'audit.recorded',
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });

      return { entry: toRecorded(created), created: true };
    });
  }

  /** Consulta filtrada (lectura). Orden descendente por seq. */
  async query(filters: QueryFilters): Promise<RecordedEntry[]> {
    const where: Prisma.AuditLogWhereInput = {
      resourceType: filters.resourceType,
      resourceId: filters.resourceId,
      actorId: filters.actorId,
      action: filters.action,
      seq: filters.beforeSeq !== undefined ? { lt: filters.beforeSeq } : undefined,
    };
    const rows = await this.prisma.read.auditLog.findMany({
      where,
      orderBy: { seq: 'desc' },
      take: filters.limit,
    });
    return rows.map(toRecorded);
  }

  /** Rango de la cadena por seq (ascendente) para verificación de integridad. */
  async getRange(fromSeq?: bigint, toSeq?: bigint): Promise<ChainRow[]> {
    const rows = await this.prisma.read.auditLog.findMany({
      where: { seq: { gte: fromSeq, lte: toSeq } },
      orderBy: { seq: 'asc' },
    });
    return rows.map(toChainRow);
  }

  async findOneByEventId(eventId: string): Promise<RecordedEntry | null> {
    const row = await this.prisma.read.auditLog.findUnique({ where: { eventId } });
    return row ? toRecorded(row) : null;
  }

  /** Entradas aún sin replicar a S3 (s3ObjectKey null), orden ascendente por seq. */
  async findUnreplicated(limit: number): Promise<RecordedEntry[]> {
    const rows = await this.prisma.read.auditLog.findMany({
      where: { s3ObjectKey: null },
      orderBy: { seq: 'asc' },
      take: limit,
    });
    return rows.map(toRecorded);
  }

  /**
   * Estampa la clave S3 (write-once). Única excepción permitida por los triggers append-only:
   * NULL -> valor. Usa updateMany con guarda s3ObjectKey:null para ser idempotente y seguro.
   */
  async stampS3Key(id: string, s3ObjectKey: string): Promise<void> {
    await this.prisma.write.auditLog.updateMany({
      where: { id, s3ObjectKey: null },
      data: { s3ObjectKey },
    });
  }

  async count(): Promise<number> {
    return this.prisma.read.auditLog.count();
  }
}

function toRecorded(row: AuditLogRow): RecordedEntry {
  return {
    id: row.id,
    seq: row.seq,
    eventId: row.eventId,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    ip: row.ip,
    userAgent: row.userAgent,
    occurredAt: row.occurredAt,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    prevHash: row.prevHash,
    hash: row.hash,
    s3ObjectKey: row.s3ObjectKey,
    createdAt: row.createdAt,
  };
}

function toChainRow(row: AuditLogRow): ChainRow {
  return {
    seq: row.seq,
    eventId: row.eventId,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    ip: row.ip,
    userAgent: row.userAgent,
    occurredAt: row.occurredAt,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}
