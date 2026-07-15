/**
 * PoliciesService — CRUD interno del registro PBAC (ADR-024, Fase 0 · el STORAGE de las políticas de gobierno).
 * Molde radius-config/pricing: tabla versionada → PUT interno que VALIDA + bumpea `version` + persiste + EMITE
 * `policy.updated` por outbox en la MISMA tx (audit WORM + invalidación de cache de @veo/policy · Fase 1).
 *
 * La FORMA de cada política (schema Zod de `params`, defaults fail-safe, flag `mandatory`, familia) es del
 * catálogo canónico de @veo/policy — fuente ÚNICA contra la deriva UI↔backend (ADR §9). El service NO reimplementa
 * validación: delega en `validateParams`/`getPolicyDef`. RBAC fino (SUPERADMIN) + step-up los aplica el admin-bff
 * en el borde (Ola 3); acá solo InternalIdentityGuard (identidad admin-rail firmada), como el resto de lo interno.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import {
  getPolicyDef,
  isPolicyKey,
  safeValidateParams,
  type PolicyKey,
  type PolicyParams,
} from '@veo/policy';
import {
  ConcurrencyConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@veo/utils';
import { PoliciesRepository, type PolicyVersionData } from './policies.repository';
import { Prisma, type Policy, type PolicyVersion } from '../generated/prisma';

const PRODUCER = 'identity-service';

/** Nombre del evento de outbox del cambio de política (const tipada, NUNCA string suelto). */
export const POLICY_UPDATED = 'policy.updated' as const;

/** Vista de una política que exponen los endpoints internos (row + `params` como objeto plano). */
export interface PolicyView {
  key: string;
  family: string;
  enabled: boolean;
  params: PolicyParams;
  mandatory: boolean;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/** Parche del PUT: solo lo que el admin puede tocar (enabled/params). Ambos opcionales (patch parcial). */
export interface UpdatePolicyPatch {
  enabled?: boolean;
  params?: PolicyParams;
  /**
   * CAS optimista (opcional): la versión que el admin TENÍA a la vista al editar. Si al aplicar la fila ya está
   * en otra versión (otro admin la cambió entremedio), se aborta con 409 en vez de pisar el cambio ajeno
   * (last-write-wins). `undefined` = sin CAS (compat / mutaciones internas que no lo mandan).
   */
  expectedVersion?: number;
}

/** Una entrada del HISTORIAL de una política (snapshot de una versión · timeline del detalle). */
export interface PolicyVersionView {
  version: number;
  enabled: boolean;
  params: PolicyParams;
  changedBy: string;
  changedAt: string;
}

/** TTL del cache de params vigentes para enforcement interno (hot-path como el masking por request). */
const PARAMS_CACHE_TTL_MS = 15_000;

@Injectable()
export class PoliciesService {
  private readonly logger = new Logger(PoliciesService.name);

  /**
   * Cache corto de los `params` vigentes por key, SOLO para el camino de lectura de enforcement
   * (`readParams`). Se invalida cuando `update()` escribe una política (misma instancia, singleton).
   * No lo usa el CRUD (`get`/`list`) — esos leen siempre fresco.
   */
  private readonly paramsCache = new Map<PolicyKey, { params: PolicyParams; expiresAt: number }>();

  constructor(@Inject(PoliciesRepository) private readonly repo: PoliciesRepository) {}

  /** Todas las políticas vigentes (la grilla de Gobierno → Políticas). */
  async list(): Promise<PolicyView[]> {
    const rows = await this.repo.findAll();
    return rows.map((r) => this.toView(r));
  }

  /** Una política por su key. `ValidationError` si la key es desconocida; `NotFoundError` si no está seedeada. */
  async get(key: string): Promise<PolicyView> {
    if (!isPolicyKey(key)) {
      throw new ValidationError('Política desconocida', { key });
    }
    const row = await this.repo.findByKey(key);
    if (!row) throw new NotFoundError('Política no encontrada', { key });
    return this.toView(row);
  }

  /**
   * HISTORIAL de una política (timeline del detalle · más reciente primero). `ValidationError` si la key es
   * desconocida; devuelve `[]` (no lanza) si la política es válida pero AÚN no tiene cambios registrados — las
   * políticas existentes arrancan sin historia y la acumulan desde el 1er PUT (baseline + versión editada).
   */
  async history(key: string): Promise<PolicyVersionView[]> {
    if (!isPolicyKey(key)) {
      throw new ValidationError('Política desconocida', { key });
    }
    const rows = await this.repo.findHistory(key);
    return rows.map((r) => this.toVersionView(r));
  }

  /**
   * Lee los `params` VIGENTES de una política para ENFORCEMENT INTERNO de identity-service.
   *
   * identity ES el dueño del registro PBAC (tabla `Policy`), así que se lee a sí mismo DIRECTO por su
   * repo — NUNCA por el cliente Kafka de `@veo/policy` (sería circular: el owner suscribiéndose a su
   * propio `policy.updated`). Fail-safe (Ley 29733, políticas mandatory): si la fila no está seedeada,
   * el jsonb quedó corrupto, o cualquier error de lectura ⇒ cae al default del catálogo. NUNCA lanza
   * (a diferencia de `get()`, que es CRUD y sí lanza NotFound): un enforcement no se puede caer porque
   * falte una fila. Cache corto (`PARAMS_CACHE_TTL_MS`) para el hot-path; se invalida en `update()`.
   */
  async readParams(key: PolicyKey): Promise<PolicyParams> {
    const now = Date.now();
    const hit = this.paramsCache.get(key);
    if (hit && hit.expiresAt > now) return hit.params;

    const def = getPolicyDef(key);
    let params: PolicyParams = def.defaults;
    try {
      const row = await this.repo.findByKey(key);
      if (row) {
        const parsed = safeValidateParams(key, row.params);
        if (parsed.success) {
          params = parsed.data as PolicyParams;
        } else {
          this.logger.warn(
            `params vigentes de '${key}' no validan contra el schema; uso el default del catálogo`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `lectura de enforcement de '${key}' falló; fail-safe al default del catálogo`,
        err instanceof Error ? err.stack : String(err),
      );
      params = def.defaults;
    }

    this.paramsCache.set(key, { params, expiresAt: now + PARAMS_CACHE_TTL_MS });
    return params;
  }

  /**
   * `graceDays` VIGENTE de `privacy.erasure` (días de gracia del derecho al olvido · Ley 29733).
   * Lo consume el `DeletionSweeper`. Fail-safe al default del catálogo (30) si el param falta o no es
   * numérico. `privacy.erasure` es `mandatory` (siempre enabled) — solo el número es configurable.
   */
  async getErasureGraceDays(): Promise<number> {
    return this.readNumberParam('privacy.erasure', 'graceDays');
  }

  /**
   * `dniTail` VIGENTE de `pii.mask` (nº de dígitos del DNI visibles al PROPIO dueño). Lo consume el
   * masking de `common/document.ts` vía su caller. Fail-safe al default del catálogo (4).
   */
  async getPiiMaskDniTail(): Promise<number> {
    return this.readNumberParam('pii.mask', 'dniTail');
  }

  /**
   * Lee un param numérico vigente con narrowing + fallback al default del catálogo (centraliza acá el
   * conocimiento de la forma, ya que este service es el dueño del registro). En la práctica, cuando la
   * fila existe y valida, el valor ya es un número (schema Zod `z.number().int()`); el guard cubre el
   * fail-safe (fila ausente/corrupta) y satisface a TS (`params` es `Record<string, unknown>`).
   */
  private async readNumberParam(key: PolicyKey, field: string): Promise<number> {
    const params = await this.readParams(key);
    const value = params[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const fallback = getPolicyDef(key).defaults[field];
    return typeof fallback === 'number' ? fallback : 0;
  }

  /**
   * PUT interno: aplica el parche del admin sobre la política `key`. En UNA transacción:
   *  1) VALIDA `params` contra el schema Zod de la key (@veo/policy) — inválido ⇒ ValidationError (400).
   *  2) Candado `mandatory` (Ley 29733): si la política es obligatoria, `enabled:false` ⇒ ForbiddenError (403).
   *  3) Bump de `version` + upsert del estado + `enqueueOutbox('policy.updated')` EN LA MISMA tx (audit + cache).
   * El estado resultante se resuelve como parche → estado actual → default del catálogo (fail-safe si falta fila).
   */
  async update(key: string, patch: UpdatePolicyPatch, actorId: string): Promise<PolicyView> {
    if (!isPolicyKey(key)) {
      throw new ValidationError('Política desconocida', { key });
    }
    const def = getPolicyDef(key);

    const row = await this.repo.runInTransaction(async (tx) => {
      const current = await this.repo.findByKeyTx(tx, key);

      // CAS optimista: si el admin mandó la versión que tenía a la vista y la fila ya avanzó (otro admin la
      // cambió entremedio), abortar con 409 en vez de pisar el cambio ajeno. Read fresco DENTRO de la tx (sin
      // lag de réplica). Sin `expectedVersion` o sin fila (primer write) → no aplica (compat).
      if (
        patch.expectedVersion !== undefined &&
        current &&
        current.version !== patch.expectedVersion
      ) {
        throw new ConcurrencyConflictError(
          'La política cambió desde que la abriste; recargá y reintentá',
          { key, expected: patch.expectedVersion, actual: current.version },
        );
      }

      // Estado resultante: el parche gana; si no viene, se conserva lo actual; si no hay fila, el default seguro.
      const nextEnabled = patch.enabled ?? current?.enabled ?? def.defaultEnabled;
      const nextParamsRaw =
        patch.params ?? (current?.params as PolicyParams | undefined) ?? def.defaults;

      // 1) Validación de forma: el schema Zod de la política es la fuente única (ADR §9).
      const parsed = safeValidateParams(key, nextParamsRaw);
      if (!parsed.success) {
        throw new ValidationError('Parámetros inválidos para la política', {
          key,
          issues: parsed.error.issues,
        });
      }
      const nextParams = parsed.data as PolicyParams;

      // 2) Candado legal: una política obligatoria NO se puede desactivar (candado del diseño · Ley 29733).
      if (def.mandatory && nextEnabled === false) {
        throw new ForbiddenError('No se puede desactivar una política obligatoria (Ley 29733)', {
          key,
        });
      }

      // 3) Bump + upsert + historial + outbox EN LA MISMA tx (estado ↔ historial ↔ auditoría ↔ cache-busting).
      const nextVersion = (current?.version ?? 0) + 1;
      const saved = await this.repo.upsertTx(tx, {
        key,
        family: def.family,
        enabled: nextEnabled,
        params: nextParams as Prisma.InputJsonValue,
        mandatory: def.mandatory,
        version: nextVersion,
        updatedBy: actorId,
      });

      // Historial (timeline del detalle): en el 1er PUT de una política SIN historia, sembramos el BASELINE (la
      // versión vigente pre-edit) para que el timeline arranque en v1 (creada/seed) y no desde la 1ª edición.
      const versionRows: PolicyVersionData[] = [];
      const hadHistory = await this.repo.hasVersionsTx(tx, key);
      if (!hadHistory && current) {
        versionRows.push({
          policyKey: key,
          version: current.version,
          enabled: current.enabled,
          params: (current.params ?? {}) as Prisma.InputJsonValue,
          changedBy: current.updatedBy,
          changedAt: current.updatedAt,
        });
      }
      versionRows.push({
        policyKey: key,
        version: nextVersion,
        enabled: nextEnabled,
        params: nextParams as Prisma.InputJsonValue,
        changedBy: actorId,
      });
      await this.repo.appendVersionsTx(tx, versionRows);

      await this.repo.enqueueOutbox(tx, this.policyUpdatedEnvelope(saved), key);
      return saved;
    });

    // Invalida el cache de enforcement de ESTA key: la próxima `readParams` relee el estado recién escrito
    // (el cache es para el hot-path, no para servir params stale tras un cambio del superadmin).
    this.paramsCache.delete(key);

    this.logger.log(
      `política '${key}' actualizada → v${row.version} (enabled=${row.enabled}) por ${actorId}; ` +
        `${POLICY_UPDATED} emitido`,
    );
    return this.toView(row);
  }

  /**
   * Envelope de `policy.updated` (consumido por audit-service → WORM inmutable, y por el cliente runtime de
   * @veo/policy → invalidación de cache · Fase 1). Sin PII: keys de config, flags, versión y actor. El eventId
   * (uuidv7) lo genera createEnvelope → el audit dedupea por eventId.
   */
  private policyUpdatedEnvelope(row: Policy) {
    return createEnvelope({
      eventType: POLICY_UPDATED,
      producer: PRODUCER,
      payload: {
        key: row.key,
        family: row.family,
        enabled: row.enabled,
        params: row.params as PolicyParams,
        version: row.version,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  }

  private toView(row: Policy): PolicyView {
    return {
      key: row.key,
      family: row.family,
      enabled: row.enabled,
      params: (row.params ?? {}) as PolicyParams,
      mandatory: row.mandatory,
      version: row.version,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toVersionView(row: PolicyVersion): PolicyVersionView {
    return {
      version: row.version,
      enabled: row.enabled,
      params: (row.params ?? {}) as PolicyParams,
      changedBy: row.changedBy,
      changedAt: row.changedAt.toISOString(),
    };
  }
}
