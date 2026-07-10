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
  type PolicyParams,
} from '@veo/policy';
import { ForbiddenError, NotFoundError, ValidationError } from '@veo/utils';
import { PoliciesRepository } from './policies.repository';
import { Prisma, type Policy } from '../generated/prisma';

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
}

@Injectable()
export class PoliciesService {
  private readonly logger = new Logger(PoliciesService.name);

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

      // 3) Bump + upsert + outbox EN LA MISMA tx (estado ↔ auditoría ↔ cache-busting, atómicos).
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
      await this.repo.enqueueOutbox(tx, this.policyUpdatedEnvelope(saved), key);
      return saved;
    });

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
}
