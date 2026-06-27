/**
 * Puerto + adaptador Prisma del SINGLETON commission_config (F2.7 · clean arch). Espeja
 * PrismaBaseFareRepository de trip-service: el CommissionService depende de la INTERFAZ (COMMISSION_REPO), no
 * de Prisma — se testea con un repo en memoria; la persistencia vive en el adaptador.
 *
 * La config es UN singleton GLOBAL con DOS tasas en BASIS POINTS Int (0..10000), Tier 1 GLOBAL: la comisión
 * ON-DEMAND (descontada al conductor) y el service fee CARPOOLING (sumado al pasajero). Ambas admin-editables. La
 * fila SIEMPRE existe en prod (la siembra la migración: on-demand 2000 bps = 20%, carpooling 0); `find` devuelve
 * `null` solo en una DB sin migrar (tests).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

/** Token DI del puerto (inyección por interfaz). */
export const COMMISSION_REPO = Symbol('COMMISSION_REPO');

/** Id fijo del singleton (Tier 1 GLOBAL). */
export const COMMISSION_SINGLETON_ID = 'GLOBAL';

/** Config persistida de la comisión por modo + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedCommission {
  /** Tasa de comisión ON-DEMAND en basis points Int (0..10000; 2000 = 20%) — descontada al conductor. Jamás float. */
  onDemandRateBps: number;
  /** Service fee CARPOOLING en basis points Int (0..10000) — sumado al pasajero (cost-sharing). Jamás float. */
  carpoolingFeeBps: number;
  version: number;
  updatedAt: string;
}

/**
 * Cliente de transacción mínimo aceptado por `replace` (config + outbox en la MISMA tx).
 * Optimistic locking (CAS): `updateMany` con `version` en el WHERE → el predicado se evalúa bajo lock al
 * escribir, así dos PUT concurrentes NO pueden ambos bumpear desde la misma versión (el 2º ve count=0).
 * `create` cubre el primer write (sin fila); `findUnique` relee la fila escrita para el `updatedAt`.
 */
export interface CommissionTx {
  commissionConfig: {
    updateMany(args: {
      where: { id: string; version: number };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    create(args: { data: Record<string, unknown> }): Promise<{ version: number; updatedAt: Date }>;
    findUnique(args: {
      where: { id: string };
    }): Promise<{ version: number; updatedAt: Date } | null>;
  };
  outboxEvent: {
    create(args: {
      data: { aggregateId: string; eventType: string; envelope: unknown };
    }): Promise<unknown>;
  };
}

/** Puerto: el servicio depende de esto, no de Prisma. */
export interface CommissionRepository {
  /** Lee el singleton; `null` si la fila aún no existe (DB sin migrar). */
  find(): Promise<PersistedCommission | null>;
  /** Abre una transacción de escritura (replace + outbox). */
  runInTx<T>(fn: (tx: CommissionTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaCommissionRepository implements CommissionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(): Promise<PersistedCommission | null> {
    const row = await this.prisma.read.commissionConfig.findUnique({
      where: { id: COMMISSION_SINGLETON_ID },
    });
    if (!row) return null;
    return {
      onDemandRateBps: row.onDemandRateBps,
      carpoolingFeeBps: row.carpoolingFeeBps,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: CommissionTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as CommissionTx));
  }
}
