/**
 * Puerto + adaptador Prisma del SINGLETON base_fare_config (F2.4 · clean arch). Espeja
 * PrismaFuelSurchargeRepository: el BaseFareService depende de la INTERFAZ (BASE_FARE_REPO), no de Prisma
 * — se testea con un repo en memoria; la persistencia vive en el adaptador.
 *
 * La tarifa base son TRES escalares globales en céntimos PEN (banderazo + per-km + per-min), Tier 1 GLOBAL
 * (un solo valor; per-país = F8, no-breaking). No hay JSON que parsear. La fila SIEMPRE existe en prod (la
 * siembra la migración con 600/120/30); `find` devuelve `null` solo en una DB sin migrar (tests/fresh).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

/** Token DI del puerto (inyección por interfaz). */
export const BASE_FARE_REPO = Symbol('BASE_FARE_REPO');

/** Id fijo del singleton (Tier 1 GLOBAL). */
export const BASE_FARE_SINGLETON_ID = 'GLOBAL';

/** Config persistida de la tarifa base + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedBaseFare {
  /** Banderazo (tarifa fija de arranque) en céntimos PEN. */
  baseFareCents: number;
  /** Costo por kilómetro en céntimos PEN. */
  perKmCents: number;
  /** Costo por minuto en céntimos PEN. */
  perMinCents: number;
  version: number;
  updatedAt: string;
}

/**
 * Cliente de transacción mínimo aceptado por `replace` (config + outbox en la MISMA tx).
 * Optimistic locking (CAS): `updateMany` con `version` en el WHERE → el predicado se evalúa bajo lock al
 * escribir, así dos PUT concurrentes NO pueden ambos bumpear desde la misma versión (el 2º ve count=0).
 * `create` cubre el primer write (sin fila); `findUnique` relee la fila escrita para el `updatedAt`.
 */
export interface BaseFareTx {
  baseFareConfig: {
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
export interface BaseFareRepository {
  /** Lee el singleton; `null` si la fila aún no existe (DB sin migrar). */
  find(): Promise<PersistedBaseFare | null>;
  /** Abre una transacción de escritura (replace + outbox). */
  runInTx<T>(fn: (tx: BaseFareTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaBaseFareRepository implements BaseFareRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(): Promise<PersistedBaseFare | null> {
    const row = await this.prisma.read.baseFareConfig.findUnique({
      where: { id: BASE_FARE_SINGLETON_ID },
    });
    if (!row) return null;
    return {
      baseFareCents: row.baseFareCents,
      perKmCents: row.perKmCents,
      perMinCents: row.perMinCents,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: BaseFareTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as BaseFareTx));
  }
}
