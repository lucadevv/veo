/**
 * AuditService — orquesta el registro inmutable y la verificación de integridad.
 * - record* construye el contenido y delega el append (hash chain) al repositorio.
 * - verifyRange recorre la cadena y detecta tampering (ver chain.ts).
 * La réplica WORM a S3 la realiza el relay (S3ReplicationRelay), desacoplado y resiliente.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { uuidv7 } from '@veo/utils';
import type { EventEnvelope } from '@veo/events';
import { domainEventsTotal, BusinessEventResult } from '@veo/observability';
import { AuditRepository, type AppendResult, type RecordedEntry } from './audit.repository';
import { verifyChain, type ChainVerificationResult } from './chain';
import { projectAuditPayload } from './payload-projection';

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

/** Token DI del tamaño de lote de `verifyRange` (lo provee AuditModule desde `AUDIT_VERIFY_BATCH_SIZE`). */
export const VERIFY_BATCH_SIZE = Symbol('audit.verifyBatchSize');

/** Default si no se inyecta config (ver `AUDIT_VERIFY_BATCH_SIZE` en env.schema para el porqué del 2000). */
export const DEFAULT_VERIFY_BATCH_SIZE = 2000;
/** Tope duro: aun con un env disparatado, el lote no rompe la cota de memoria que justifica el streaming. */
const MAX_VERIFY_BATCH_SIZE = 10_000;

function clampVerifyBatchSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size) || size < 1) return DEFAULT_VERIFY_BATCH_SIZE;
  return Math.min(Math.trunc(size), MAX_VERIFY_BATCH_SIZE);
}

@Injectable()
export class AuditService {
  /** Filas por lote del recorrido keyset de `verifyRange` (memoria acotada). */
  private readonly verifyBatchSize: number;

  constructor(
    private readonly repo: AuditRepository,
    // @Optional: los specs construyen el service a mano (sin DI). Sin inyección → DEFAULT_VERIFY_BATCH_SIZE.
    // En tests pasamos un lote CHICO (p.ej. 3) para forzar multi-lote y ejercitar el hash arrastrado del borde.
    @Optional() @Inject(VERIFY_BATCH_SIZE) batchSize?: number,
  ) {
    this.verifyBatchSize = clampVerifyBatchSize(batchSize);
  }

  /**
   * Registro síncrono iniciado por otro servicio (acción directa, no evento · POST /audit + gRPC Record).
   *
   * SOBERANÍA (FOUNDATION §0.7 · Ley 29733): el payload se PROYECTA con `projectAuditPayload` ANTES de
   * persistir, IGUAL que `recordFromEvent` — este es el mismo choke point para el carril síncrono. Sin esto,
   * los callers (admin-bff: `operator.create` con {email}, `payment.refund`/`media.access_request` con
   * {reason} free-text) fijaban PII en el WORM inmutable. La `action` (operator.create, payment.refund,
   * media.access_*…) es la KEY de proyección: sin allowlist → `{}` vacío (safe-by-default, dropea email/reason;
   * la fila conserva who/what/which/when). NOTA DEUDA PRE-EXISTENTE (fuera de este lote): recordSync NO es
   * idempotente (eventId autogenerado por request) — a diferencia de recordFromEvent (idempotente por eventId).
   */
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
      payload: projectAuditPayload(input.action, input.payload),
    });
    domainEventsTotal.inc({ event: input.action, result: BusinessEventResult.RECORDED });
    return result.entry;
  }

  /**
   * Registro a partir de un evento de dominio consumido de Kafka. Idempotente por eventId.
   *
   * SOBERANÍA (FOUNDATION §0.7 · Ley 29733): el payload del evento se PROYECTA con `projectAuditPayload`
   * (allowlist tipada por eventType) ANTES de persistir. El WORM es inmutable (object-lock) → NUNCA debe
   * fijar PII. La proyección es safe-by-default (un evento sin allowlist → `{}`) y tiene una denylist PII
   * defensiva. La esencia forense (quién/qué/cuál/cuándo) vive en las columnas actor/action/resource/occurredAt.
   */
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
      payload: projectAuditPayload(envelope.eventType, envelope.payload),
    });
    domainEventsTotal.inc({
      event: envelope.eventType,
      result: result.created ? BusinessEventResult.RECORDED : BusinessEventResult.DUPLICATE,
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

  /**
   * Verifica la integridad de la cadena en un rango [fromSeq, toSeq] por STREAMING (anti-OOM).
   *
   * NO materializa la tabla append-only entera (millones de eslabones) en memoria —eso era el OOM
   * auto-infligido del hot-path de compliance—: la recorre en LOTES keyset por `seq` (`getChainBatch`),
   * arrastrando el último hash de cada lote al siguiente. La memoria queda acotada a `verifyBatchSize`
   * filas, y el resultado (valid / dónde rompe) es IDÉNTICO al de verificar la cadena entera de una vez:
   *
   *  - Cada lote verifica su cadena INTERNA con `verifyChain`.
   *  - El enlace CRUZADO (primera fila del lote N contra el último hash del lote N-1) se valida pasando
   *    `startingPrevHash` → un tampering en el BORDE de lote se caza igual que uno en el medio.
   *  - El `fromSeq` INCLUSIVO se respeta con un cursor inicial `fromSeq - 1n` (gt(x-1) ≡ gte(x) en enteros).
   *  - `expectGenesis` (prevHash null en seq=1) solo aplica al PRIMER lote, igual que antes.
   */
  async verifyRange(input: VerifyRangeInput): Promise<VerifyRangeResult> {
    const expectGenesis = input.fromSeq === undefined || input.fromSeq <= 1n;
    // Cursor keyset EXCLUSIVO (gt). fromSeq-1n para honrar el límite inferior INCLUSIVO del contrato.
    let cursor: bigint | undefined = input.fromSeq === undefined ? undefined : input.fromSeq - 1n;
    let carriedPrevHash: string | null = null;
    let isFirstBatch = true;
    let checked = 0;
    let firstSeq: bigint | null = null;
    let lastSeq: bigint | null = null;

    for (;;) {
      const batch = await this.repo.getChainBatch(cursor, input.toSeq, this.verifyBatchSize);
      if (batch.length === 0) break;
      if (firstSeq === null) firstSeq = BigInt(batch[0]!.seq);

      const result = verifyChain(batch, {
        expectGenesis: isFirstBatch ? expectGenesis : false,
        // Lote ≥2: el enlace cruzado se valida contra el hash arrastrado (NO se confía el borde).
        startingPrevHash: isFirstBatch ? undefined : carriedPrevHash,
      });
      if (!result.valid) {
        // `checked` global = filas ya verificadas en lotes previos + el índice de la rotura en éste.
        // brokenAtSeq/reason son del seq real → idénticos a la verificación no-paginada.
        return {
          valid: false,
          checked: checked + result.checked,
          brokenAtSeq: result.brokenAtSeq,
          reason: result.reason,
          fromSeq: firstSeq !== null ? String(firstSeq) : null,
          toSeq: lastSeq !== null ? String(lastSeq) : null,
        };
      }

      checked += result.checked;
      const last = batch[batch.length - 1]!;
      carriedPrevHash = last.hash;
      lastSeq = BigInt(last.seq);
      cursor = lastSeq;
      isFirstBatch = false;

      // Lote incompleto ⇒ última página: corta una query extra que devolvería 0 filas.
      if (batch.length < this.verifyBatchSize) break;
    }

    return {
      valid: true,
      checked,
      fromSeq: firstSeq !== null ? String(firstSeq) : null,
      toSeq: lastSeq !== null ? String(lastSeq) : null,
    };
  }
}
