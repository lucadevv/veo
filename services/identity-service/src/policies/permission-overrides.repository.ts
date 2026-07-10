/**
 * PermissionOverridesRepository — ÚNICO punto de acceso Prisma del registro `PermissionOverride` (overlay de
 * visibilidad · ADR-025 §3, schema 'identity', módulo `gobierno` de facto = AL LADO de las Políticas). Espeja
 * EXACTAMENTE el molde de PoliciesRepository: read/write split, OUTBOX-EN-TRANSACCIÓN (la mutación del override
 * y su `permission_override.updated` van en la MISMA tx · Ley 29733 · libro WORM) y métodos con NOMBRES DE
 * DOMINIO — nunca filtra `PrismaClient` crudo al service (FOUNDATION §10).
 *
 * SEAM con PermissionOverridesService: la LÓGICA (invariante subtract-only contra la matriz base de `@veo/policy`,
 * candado legal-mandatory, bump de `version`, armado del envelope) vive ENTERA en el service. Este repo solo hace
 * acceso a datos. El upsert usa la clave compuesta `role_permission` (@@id([role, permission])); el update es
 * tx-scoped (el service lee fresco → decide → escribe + encola outbox, sin tocar nunca `this.prisma`). Sin SEED:
 * el overlay arranca VACÍO (sin restricciones = base pura), a diferencia del catálogo de Políticas.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type PermissionOverride } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type PermissionOverrideTx = Prisma.TransactionClient;

/** Data del upsert de un override (el service la arma con el estado resuelto + validado + la `version` bumpeada). */
export interface UpsertPermissionOverrideData {
  role: string;
  permission: string;
  hidden: boolean;
  version: number;
  updatedBy: string;
}

@Injectable()
export class PermissionOverridesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ────────────────────────────────────────────────────────────────────────────────

  /** Todos los overrides vigentes, en orden estable por (role, permission) (para la grilla del admin). Réplica. */
  findAll(): Promise<PermissionOverride[]> {
    return this.prisma.read.permissionOverride.findMany({
      orderBy: [{ role: 'asc' }, { permission: 'asc' }],
    });
  }

  /** Un override por su par (role, permission). `null` si no existe (⇒ rige la base). Réplica. */
  findByPair(role: string, permission: string): Promise<PermissionOverride | null> {
    return this.prisma.read.permissionOverride.findUnique({
      where: { role_permission: { role, permission } },
    });
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /** Dueño del `$transaction` (write). El service ORQUESTA la lectura fresca + el upsert + el outbox tx-scoped. */
  runInTransaction<T>(work: (tx: PermissionOverrideTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Override por par DENTRO de la tx (dato FRESCO para computar el bump de `version`, sin lag de réplica). */
  findByPairTx(
    tx: PermissionOverrideTx,
    role: string,
    permission: string,
  ): Promise<PermissionOverride | null> {
    return tx.permissionOverride.findUnique({
      where: { role_permission: { role, permission } },
    });
  }

  /**
   * Upsert del override DENTRO de la tx (create si falta, replace de `hidden`/`version`/`updatedBy` si existe).
   * El service arma la `data` con el estado ya resuelto + validado y la `version` ya bumpeada.
   */
  upsertTx(
    tx: PermissionOverrideTx,
    data: UpsertPermissionOverrideData,
  ): Promise<PermissionOverride> {
    const { role, permission, hidden, version, updatedBy } = data;
    return tx.permissionOverride.upsert({
      where: { role_permission: { role, permission } },
      create: { role, permission, hidden, version, updatedBy },
      update: { hidden, version, updatedBy },
    });
  }

  /** Persiste un evento en el outbox DENTRO de la tx (Ley 29733 · WORM). El service arma el envelope. */
  async enqueueOutbox(
    tx: PermissionOverrideTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }
}
