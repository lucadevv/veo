/**
 * PoliciesRepository — ÚNICO punto de acceso Prisma del registro PBAC `Policy` (ADR-024, schema 'identity').
 * Espeja el mold de admin/consents: read/write split, OUTBOX-EN-TRANSACCIÓN (la mutación de política y su
 * `policy.updated` van en la MISMA tx · Ley 29733 · libro WORM) y métodos con NOMBRES DE DOMINIO — nunca filtra
 * `PrismaClient` crudo al service (FOUNDATION §10).
 *
 * SEAM con PoliciesService: la LÓGICA (validación Zod de `params` vía @veo/policy, candado `mandatory`, bump de
 * `version`, armado del envelope) vive ENTERA en el service. Este repo solo hace acceso a datos. El update usa
 * `runInTransaction` + métodos tx-scoped (el service lee fresco → decide → escribe + encola outbox, sin tocar
 * nunca `this.prisma`), igual que AdminRepository. El SEED idempotente usa `createMany(skipDuplicates)`: inserta
 * SOLO las keys del catálogo que faltan y NUNCA pisa el estado que el admin ya cambió.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Policy } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type PolicyTx = Prisma.TransactionClient;

/** Data del upsert de una política (el service la arma con el estado resuelto + validado). */
export interface UpsertPolicyData {
  key: string;
  family: string;
  enabled: boolean;
  params: Prisma.InputJsonValue;
  mandatory: boolean;
  version: number;
  updatedBy: string;
}

@Injectable()
export class PoliciesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ────────────────────────────────────────────────────────────────────────────────

  /** Todas las políticas vigentes, en orden estable por key (para la grilla del admin). Réplica. */
  findAll(): Promise<Policy[]> {
    return this.prisma.read.policy.findMany({ orderBy: { key: 'asc' } });
  }

  /** Una política por su key (@id). `null` si no existe. Réplica. */
  findByKey(key: string): Promise<Policy | null> {
    return this.prisma.read.policy.findUnique({ where: { key } });
  }

  // ── Seed idempotente (primary) ────────────────────────────────────────────────────────────────────────

  /**
   * Inserta SOLO las políticas cuya key aún NO existe (`skipDuplicates`). Es la garantía de "catálogo siempre
   * completo" del ADR: correrlo dos veces no rompe ni pisa los cambios del admin (una key existente se SALTA,
   * su `enabled`/`params` quedan intactos). Devuelve cuántas filas se insertaron realmente.
   */
  seedMissing(rows: Prisma.PolicyCreateManyInput[]): Promise<Prisma.BatchPayload> {
    return this.prisma.write.policy.createMany({ data: rows, skipDuplicates: true });
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /** Dueño del `$transaction` (write). El service ORQUESTA la lectura fresca + el upsert + el outbox tx-scoped. */
  runInTransaction<T>(work: (tx: PolicyTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Política por key DENTRO de la tx (dato FRESCO para computar el bump de `version`, sin lag de réplica). */
  findByKeyTx(tx: PolicyTx, key: string): Promise<Policy | null> {
    return tx.policy.findUnique({ where: { key } });
  }

  /**
   * Upsert de la política DENTRO de la tx (create si falta, replace del estado si existe). El service arma la
   * `data` con el estado ya resuelto + validado y la `version` ya bumpeada.
   */
  upsertTx(tx: PolicyTx, data: UpsertPolicyData): Promise<Policy> {
    const { key, family, enabled, params, mandatory, version, updatedBy } = data;
    return tx.policy.upsert({
      where: { key },
      create: { key, family, enabled, params, mandatory, version, updatedBy },
      update: { enabled, params, version, updatedBy },
    });
  }

  /** Persiste un evento en el outbox DENTRO de la tx (Ley 29733 · WORM). El service arma el envelope. */
  async enqueueOutbox(
    tx: PolicyTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }
}
