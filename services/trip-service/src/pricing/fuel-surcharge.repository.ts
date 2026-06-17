/**
 * Puerto + adaptador Prisma del SINGLETON fuel_surcharge_config (B3 · clean arch). Espeja
 * PrismaPricingScheduleRepository: el FuelSurchargeService depende de la INTERFAZ (FUEL_SURCHARGE_REPO),
 * no de Prisma — se testea con un repo en memoria; la persistencia vive en el adaptador.
 *
 * El recargo es un ESCALAR global (céntimos PEN por km), Tier 1 GLOBAL (un solo valor; Tier 2 = per-zona,
 * no-breaking). No hay JSON que parsear: el valor es un Int con default 0 (degradación honesta: sin fila
 * o fila corrupta → 0, sin recargo).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

/** Token DI del puerto (inyección por interfaz). */
export const FUEL_SURCHARGE_REPO = Symbol('FUEL_SURCHARGE_REPO');

/** Id fijo del singleton (Tier 1 GLOBAL). */
export const FUEL_SINGLETON_ID = 'GLOBAL';

/** Config persistida del recargo + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedFuelSurcharge {
  /** B4 · precio del combustible por litro (céntimos PEN). */
  fuelPricePerLiterCents: number;
  /** B4 · rendimiento del vehículo de referencia (km por litro). */
  kmPerLiter: number;
  version: number;
  updatedAt: string;
}

/**
 * Cliente de transacción mínimo aceptado por `replace` (config + outbox en la MISMA tx).
 * Optimistic locking (CAS): `updateMany` con `version` en el WHERE → el predicado se evalúa bajo lock al
 * escribir, así dos PUT concurrentes NO pueden ambos bumpear desde la misma versión (el 2º ve count=0).
 * `create` cubre el primer write (sin fila); `findUnique` relee la fila escrita para el `updatedAt`.
 */
export interface FuelSurchargeTx {
  fuelSurchargeConfig: {
    updateMany(args: {
      where: { id: string; version: number };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    create(args: { data: Record<string, unknown> }): Promise<{ version: number; updatedAt: Date }>;
    findUnique(args: { where: { id: string } }): Promise<{ version: number; updatedAt: Date } | null>;
  };
  outboxEvent: {
    create(args: { data: { aggregateId: string; eventType: string; envelope: unknown } }): Promise<unknown>;
  };
}

/** Puerto: el servicio depende de esto, no de Prisma. */
export interface FuelSurchargeRepository {
  /** Lee el singleton; `null` si la fila aún no existe (el servicio degrada a 0 = sin recargo). */
  find(): Promise<PersistedFuelSurcharge | null>;
  /** Abre una transacción de escritura (replace + outbox). */
  runInTx<T>(fn: (tx: FuelSurchargeTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaFuelSurchargeRepository implements FuelSurchargeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(): Promise<PersistedFuelSurcharge | null> {
    const row = await this.prisma.read.fuelSurchargeConfig.findUnique({ where: { id: FUEL_SINGLETON_ID } });
    if (!row) return null;
    return {
      fuelPricePerLiterCents: row.fuelPricePerLiterCents,
      kmPerLiter: row.kmPerLiter,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: FuelSurchargeTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as FuelSurchargeTx));
  }
}
