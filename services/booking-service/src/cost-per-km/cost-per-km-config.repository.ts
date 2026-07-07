/**
 * Puerto + adaptador Prisma de la config CostPerKmConfig POR PAÍS (F2.5 · clean arch). Espeja
 * PrismaCommissionRepository de payment-service, pero NO es singleton: hay UNA fila por país (PK = `pais`),
 * y cada país versiona su tarifa por separado (CAS per-país). El CostPerKmConfigService depende de la
 * INTERFAZ (COST_PER_KM_CONFIG_REPO), no de Prisma — se testea con un repo en memoria.
 *
 * El costo/km es UN escalar por país en céntimos PEN Int (costo de OPERACIÓN: combustible + desgaste). La
 * fila SIEMPRE existe en prod (la siembra la migración: PE=150, EC=50); `find` devuelve `null` solo en una
 * DB sin migrar o para un país sin sembrar → el service degrada al env (degradación honesta).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

/** Token DI del puerto (inyección por interfaz). */
export const COST_PER_KM_CONFIG_REPO = Symbol('COST_PER_KM_CONFIG_REPO');

/** Config persistida del costo/km de UN país + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedCostPerKm {
  /** País (PE/EC). */
  pais: string;
  /** Costo de operación por km en céntimos PEN Int (combustible + desgaste). Jamás float. */
  costPerKmCents: number;
  version: number;
  updatedAt: string;
}

/**
 * Cliente de transacción mínimo aceptado por `replace`. Optimistic locking (CAS): `updateMany` con `version`
 * (y `pais`) en el WHERE → el predicado se evalúa bajo lock al escribir, así dos PUT concurrentes del MISMO
 * país NO pueden ambos bumpear desde la misma versión (el 2º ve count=0). `create` cubre el primer write de
 * un país sin fila; `findUnique` relee la fila escrita para el `updatedAt` autoritativo.
 */
export interface CostPerKmTx {
  costPerKmConfig: {
    updateMany(args: {
      where: { pais: string; version: number };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    create(args: { data: Record<string, unknown> }): Promise<{ version: number; updatedAt: Date }>;
    findUnique(args: {
      where: { pais: string };
    }): Promise<{ version: number; updatedAt: Date } | null>;
  };
}

/** Puerto: el servicio depende de esto, no de Prisma. */
export interface CostPerKmConfigRepository {
  /** Lee la fila de un país; `null` si no existe (DB sin migrar / país no sembrado). */
  find(pais: string): Promise<PersistedCostPerKm | null>;
  /** Abre una transacción de escritura (replace per-país). */
  runInTx<T>(fn: (tx: CostPerKmTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaCostPerKmConfigRepository implements CostPerKmConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(pais: string): Promise<PersistedCostPerKm | null> {
    const row = await this.prisma.read.costPerKmConfig.findUnique({ where: { pais } });
    if (!row) return null;
    return {
      pais: row.pais,
      costPerKmCents: row.costPerKmCents,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: CostPerKmTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as CostPerKmTx));
  }
}
