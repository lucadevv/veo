/**
 * PermissionOverridesService — CRUD interno del OVERLAY de visibilidad de permisos (ADR-025 §3, Ola 2 · el
 * STORAGE de la capa 2 del gobierno unificado). Vive AL LADO de PoliciesService, mismo molde: tabla versionada →
 * PUT interno que VALIDA + bumpea `version` + persiste + EMITE `permission_override.updated` por outbox en la
 * MISMA tx (audit WORM + invalidación de cache de `@veo/policy`).
 *
 * INVARIANTE MAESTRO (ADR-025 §1/§3): el overlay es SUBTRACT-ONLY — solo RESTA, nunca concede. Se enforcea, no se
 * confía. Para eso el service consulta la MATRIZ BASE (`PERMISSION_ROLES` de `@veo/policy`, FUENTE ÚNICA front+back):
 *   1) `role`/`permission` deben ser canónicos (AdminRole × Permission del catálogo) — si no, ValidationError.
 *   2) subtract-only: se RECHAZA cualquier override sobre un par (rol, permiso) que la BASE NO concede — "restar" lo
 *      que no existe sería un intento encubierto de conceder (el overlay solo agrega negaciones).
 *   3) candado legal: un permiso legal-mandatory (audit:view / audit:verify / finance:payout · separación de
 *      funciones Ley 29733) NO es restable-off — se RECHAZA `hidden=true` sobre él, igual que una política `mandatory`.
 *
 * RBAC fino (SUPERADMIN) + step-up MFA los aplica el admin-bff EN EL BORDE (Ola 3); acá solo InternalIdentityGuard
 * (identidad admin-rail firmada), como el resto de lo interno.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import {
  baseGrants,
  isAdminRole,
  isLegalMandatoryPermission,
  isPermission,
  overrideKey,
} from '@veo/policy';
import { ConcurrencyConflictError, ForbiddenError, ValidationError } from '@veo/utils';
import { PermissionOverridesRepository } from './permission-overrides.repository';
import type { PermissionOverride } from '../generated/prisma';

const PRODUCER = 'identity-service';

/** Nombre del evento de outbox del cambio de override (const tipada, NUNCA string suelto). */
export const PERMISSION_OVERRIDE_UPDATED = 'permission_override.updated' as const;

/** Vista de un override que exponen los endpoints internos (row proyectado, `updatedAt` como ISO). */
export interface PermissionOverrideView {
  role: string;
  permission: string;
  hidden: boolean;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

@Injectable()
export class PermissionOverridesService {
  private readonly logger = new Logger(PermissionOverridesService.name);

  constructor(
    @Inject(PermissionOverridesRepository)
    private readonly repo: PermissionOverridesRepository,
  ) {}

  /** Todos los overrides vigentes (los pares RESTADOS; ausencia de fila = base). La grilla de Gobierno → Permisos. */
  async list(): Promise<PermissionOverrideView[]> {
    const rows = await this.repo.findAll();
    return rows.map((r) => this.toView(r));
  }

  /**
   * PUT interno: aplica un override sobre el par (role, permission). En UNA transacción:
   *  1) VALIDA que `role` y `permission` sean canónicos (AdminRole × Permission) — inválido ⇒ ValidationError (400).
   *  2) Invariante SUBTRACT-ONLY: rechaza el par que la BASE NO concede ⇒ ValidationError (400).
   *  3) Candado LEGAL: rechaza `hidden=true` sobre un permiso legal-mandatory ⇒ ForbiddenError (403 · Ley 29733).
   *  4) Bump de `version` + upsert + `enqueueOutbox('permission_override.updated')` EN LA MISMA tx (audit + cache).
   * `hidden=false` DES-RESTAURA (equivale a la ausencia de fila → rige la base); persiste igual (traza + versión).
   */
  async set(
    role: string,
    permission: string,
    hidden: boolean,
    actorId: string,
    expectedVersion?: number,
  ): Promise<PermissionOverrideView> {
    // 1) Ejes canónicos: rol conocido (fila) y permiso del catálogo (columna).
    if (!isAdminRole(role)) {
      throw new ValidationError('Rol desconocido', { role });
    }
    if (!isPermission(permission)) {
      throw new ValidationError('Permiso desconocido', { permission });
    }

    // 2) Subtract-only (ADR-025 §3): solo se puede RESTAR sobre lo que la base YA concede. Restar lo que la base
    //    no da sería un intento encubierto de conceder (el overlay solo agrega negaciones) → se rechaza SIEMPRE,
    //    tanto la resta (hidden=true) como el des-restaurado (hidden=false) — un par no-base no debe tener fila.
    if (!baseGrants(role, permission)) {
      throw new ValidationError(
        'El overlay solo puede RESTAR un permiso que la base concede a ese rol (subtract-only)',
        { role, permission },
      );
    }

    // 3) Candado legal (ADR-025 §3 · separación de funciones Ley 29733): un permiso legal-mandatory no es
    //    restable-off. Solo bloquea la RESTA (hidden=true); des-restaurar (hidden=false) es inocuo (rige la base).
    if (hidden && isLegalMandatoryPermission(permission)) {
      throw new ForbiddenError(
        'No se puede restar un permiso legal-mandatory (separación de funciones · Ley 29733)',
        { role, permission },
      );
    }

    // 4) Bump + upsert + outbox EN LA MISMA tx (estado ↔ auditoría ↔ cache-busting, atómicos).
    const row = await this.repo.runInTransaction(async (tx) => {
      const current = await this.repo.findByPairTx(tx, role, permission);
      // CAS optimista: si el admin mandó la versión que tenía a la vista y el par ya avanzó (otro superadmin lo
      // cambió), abortar con 409 en vez de pisar el cambio ajeno. Read fresco DENTRO de la tx. Un par SIN fila
      // (primera resta) no lleva expectedVersion → no aplica.
      if (
        expectedVersion !== undefined &&
        current &&
        current.version !== expectedVersion
      ) {
        throw new ConcurrencyConflictError(
          'El permiso cambió desde que abriste la matriz; recargá y reintentá',
          { role, permission, expected: expectedVersion, actual: current.version },
        );
      }
      const nextVersion = (current?.version ?? 0) + 1;
      const saved = await this.repo.upsertTx(tx, {
        role,
        permission,
        hidden,
        version: nextVersion,
        updatedBy: actorId,
      });
      await this.repo.enqueueOutbox(
        tx,
        this.overrideUpdatedEnvelope(saved),
        overrideKey(role, permission),
      );
      return saved;
    });

    this.logger.log(
      `override '${overrideKey(role, permission)}' → hidden=${row.hidden} v${row.version} por ${actorId}; ` +
        `${PERMISSION_OVERRIDE_UPDATED} emitido`,
    );
    return this.toView(row);
  }

  /**
   * Envelope de `permission_override.updated` (consumido por audit-service → WORM inmutable con actor=updatedBy y
   * recurso=`role|permission`, y por el cliente runtime de `@veo/policy` → refresco del overlay). Sin PII: rol,
   * permiso, flag, versión y actor. El eventId (uuidv7) lo genera createEnvelope → el audit dedupea por eventId.
   */
  private overrideUpdatedEnvelope(row: PermissionOverride) {
    return createEnvelope({
      eventType: PERMISSION_OVERRIDE_UPDATED,
      producer: PRODUCER,
      payload: {
        role: row.role,
        permission: row.permission,
        hidden: row.hidden,
        version: row.version,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  }

  private toView(row: PermissionOverride): PermissionOverrideView {
    return {
      role: row.role,
      permission: row.permission,
      hidden: row.hidden,
      version: row.version,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
