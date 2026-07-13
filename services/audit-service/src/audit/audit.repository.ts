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
  /** Categoría = prefijo de dominio de la acción → `action startsWith "${category}."`. */
  category?: string;
  /** Búsqueda libre (substring, case-insensitive) sobre action/resourceType/resourceId/actorId. */
  q?: string;
  /**
   * IDs de actor resueltos AGUAS ARRIBA por el bff (name→ids contra el roster de operadores): permite que la
   * búsqueda libre `q` matchee por NOMBRE del operador —enriquecido on-read, no persistido en el WORM— y no solo
   * por el hash `actorId`. Se combina con `q` en un ÚNICO predicado OR (un row matchea si `q` sustring-matchea O
   * `actorId IN actorIds`). Vacío/ausente ⇒ SIN efecto: el filtro se comporta EXACTO a hoy (solo-`q`, sin regresión).
   */
  actorIds?: string[];
  /** Rango de fecha (inclusive) sobre occurredAt. */
  from?: Date;
  to?: Date;
  limit: number;
  /** Cursor: devolver entradas con seq < beforeSeq (paginación descendente). */
  beforeSeq?: bigint;
}

/** Filtros del export: los mismos estructurados, sin cursor/limit (el service acota con un tope duro). */
export type ExportFilters = Omit<QueryFilters, 'limit' | 'beforeSeq'>;

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
    const rows = await this.prisma.read.auditLog.findMany({
      where: buildQueryWhere(filters, filters.beforeSeq),
      orderBy: { seq: 'desc' },
      take: filters.limit,
    });
    return rows.map(toRecorded);
  }

  /**
   * SET COMPLETO del filtro para el export CSV (GET /audit/export), acotado por un TOPE DURO (`limit`) para
   * NO materializar el WORM entero (append-only de millones de eslabones → OOM). Orden descendente por seq
   * (lo más reciente primero, como el listado). Sin cursor: es una lectura puntual, no paginada. El admin-bff
   * arma el CSV y audita la exportación (accountability de acceso a datos de compliance · Ley 29733).
   */
  async queryForExport(filters: ExportFilters, limit: number): Promise<RecordedEntry[]> {
    const rows = await this.prisma.read.auditLog.findMany({
      where: buildQueryWhere(filters),
      orderBy: { seq: 'desc' },
      take: limit,
    });
    return rows.map(toRecorded);
  }

  /**
   * Rango de la cadena por seq (ascendente) para verificación de integridad.
   *
   * ⚠️ CARGA TODO el rango en memoria. Con ambos límites `undefined` materializa la tabla append-only ENTERA
   * (millones de eslabones) → OOM. NO usar en el hot-path de verificación: `verifyRange` recorre la cadena por
   * `getChainBatch` (streaming keyset, memoria acotada). Se conserva para lecturas ACOTADAS y puntuales
   * (p.ej. tests que leen unas pocas filas concretas), donde el rango es chico por construcción.
   */
  async getRange(fromSeq?: bigint, toSeq?: bigint): Promise<ChainRow[]> {
    const rows = await this.prisma.read.auditLog.findMany({
      where: { seq: { gte: fromSeq, lte: toSeq } },
      orderBy: { seq: 'asc' },
    });
    return rows.map(toChainRow);
  }

  /**
   * Un LOTE de la cadena por paginación KEYSET sobre `seq` (no offset, que es O(n) en Postgres) — pieza del
   * recorrido por streaming de `verifyRange` (anti-OOM). Espeja el patrón cursor de `PayoutsService.listAll`
   * (`where`/`orderBy asc`/`take`), adaptado a un cursor numérico monotónico (`seq` es @unique autoincrement).
   *
   *  - `afterSeq` es el cursor EXCLUSIVO (`gt`): el último `seq` ya devuelto. `undefined` = desde el principio.
   *    El llamador respeta un `fromSeq` INCLUSIVO arrancando el cursor en `fromSeq - 1n` (gt(x-1) ≡ gte(x) en
   *    enteros) → una sola ruta de query, sin caso especial del primer lote.
   *  - `toSeq` es la cota superior INCLUSIVA (`lte`) del rango; `undefined` = hasta el final de la cadena.
   *  - `limit` (`take`) acota la memoria: nunca trae más de `limit` filas.
   *
   * La query usa el índice único de `seq` (range-scan O(log n) + límite) → NO hace full-scan de la tabla WORM.
   */
  async getChainBatch(
    afterSeq: bigint | undefined,
    toSeq: bigint | undefined,
    limit: number,
  ): Promise<ChainRow[]> {
    const rows = await this.prisma.read.auditLog.findMany({
      where: { seq: { gt: afterSeq, lte: toSeq } },
      orderBy: { seq: 'asc' },
      take: limit,
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

/**
 * Construye el `where` de lectura del audit desde los filtros estructurados (compartido por `query` y
 * `queryForExport`). Todo se compone con un AND de cláusulas; sin filtros → where vacío (trae lo más reciente).
 *  - resourceType/resourceId/actorId/action → igualdad exacta (filtros de callers internos).
 *  - category → `action startsWith "${category}."` (prefijo de dominio; la "categoría de acción" del panel).
 *  - q / actorIds → un ÚNICO predicado OR (búsqueda libre): substring (case-insensitive) sobre
 *    action/resourceType/resourceId/actorId, O `actorId IN actorIds` (los ids que el bff resolvió por NOMBRE de
 *    operador). Un row matchea si CUALQUIERA aplica. `actorIds` vacío/ausente ⇒ el OR queda idéntico a hoy (solo-q);
 *    `q` ausente con `actorIds` presente ⇒ el OR es solo el `IN`. Ninguno de los dos ⇒ no se agrega el OR.
 *  - from/to → rango inclusivo sobre occurredAt; un `to` a medianoche se lleva al FIN del día para incluirlo todo.
 *  - beforeSeq → cursor descendente (`seq < beforeSeq`), solo en el listado paginado.
 */
export function buildQueryWhere(
  filters: {
    resourceType?: string;
    resourceId?: string;
    actorId?: string;
    action?: string;
    category?: string;
    q?: string;
    actorIds?: string[];
    from?: Date;
    to?: Date;
  },
  beforeSeq?: bigint,
): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (filters.resourceType) and.push({ resourceType: filters.resourceType });
  if (filters.resourceId) and.push({ resourceId: filters.resourceId });
  if (filters.actorId) and.push({ actorId: filters.actorId });
  if (filters.action) and.push({ action: filters.action });
  if (filters.category) and.push({ action: { startsWith: `${filters.category}.` } });
  // Búsqueda libre = UN solo OR: las 4 substrings de `q` + el `actorId IN actorIds` (name→ids del bff). Así el
  // buscador matchea por NOMBRE del operador (enriquecido on-read) sin dejar de matchear por id/acción/recurso.
  const searchOr: Prisma.AuditLogWhereInput[] = [];
  if (filters.q) {
    const q = filters.q;
    searchOr.push(
      { action: { contains: q, mode: 'insensitive' } },
      { resourceType: { contains: q, mode: 'insensitive' } },
      { resourceId: { contains: q, mode: 'insensitive' } },
      { actorId: { contains: q, mode: 'insensitive' } },
    );
  }
  if (filters.actorIds && filters.actorIds.length > 0) {
    searchOr.push({ actorId: { in: filters.actorIds } });
  }
  if (searchOr.length > 0) and.push({ OR: searchOr });
  if (filters.from || filters.to) {
    and.push({ occurredAt: { gte: filters.from, lte: endOfDayIfDateOnly(filters.to) } });
  }
  if (beforeSeq !== undefined) and.push({ seq: { lt: beforeSeq } });
  return and.length > 0 ? { AND: and } : {};
}

/**
 * Un `to` que llega SIN componente de hora (medianoche exacta UTC) se interpreta como "todo ese día": lo lleva
 * al último instante del día para que el rango [from, to] incluya los eventos de la fecha pedida (el operador
 * espera que "hasta el 12/07" incluya el 12/07 completo, no se corte a las 00:00). Un `to` con hora explícita
 * se respeta tal cual.
 */
function endOfDayIfDateOnly(to?: Date): Date | undefined {
  if (!to) return undefined;
  const isMidnightUtc =
    to.getUTCHours() === 0 &&
    to.getUTCMinutes() === 0 &&
    to.getUTCSeconds() === 0 &&
    to.getUTCMilliseconds() === 0;
  if (!isMidnightUtc) return to;
  return new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);
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
