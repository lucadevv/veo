/**
 * Puerto + adaptador Prisma del SINGLETON dispatch_radius_config (espejo del pricing_mode_schedule del
 * trip-service · clean arch). El service depende de la INTERFAZ (DISPATCH_RADIUS_CONFIG_REPO), NO de
 * Prisma: así se testea con un repo en memoria y la persistencia real vive en el adaptador.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const DISPATCH_RADIUS_CONFIG_REPO = Symbol('DISPATCH_RADIUS_CONFIG_REPO');

/** Id fijo del singleton (Tier 1 GLOBAL). */
export const SINGLETON_ID = 'GLOBAL';

/** Snapshot persistido + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedRadiusConfig {
  nearbyKRing: number;
  matchKRing: number;
  /** Ventana (ms) de la oferta directa FIXED (matching secuencial). */
  offerTimeoutMs: number;
  /** Ventana (s) del board de PUJA (openBoard/reopenBoard). */
  bidWindowSec: number;
  version: number;
  updatedAt: string;
}

/** Cliente de transacción mínimo aceptado por `runInTx` (para encolar el outbox en la MISMA tx). */
export interface RadiusConfigTx {
  dispatchRadiusConfig: {
    upsert(args: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ version: number; updatedAt: Date }>;
  };
  outboxEvent: {
    create(args: {
      data: { aggregateId: string; eventType: string; envelope: unknown };
    }): Promise<unknown>;
  };
}

/** Puerto: el servicio depende de esto, no de Prisma. */
export interface DispatchRadiusConfigRepository {
  /** Lee el singleton; `null` si la fila aún no existe (el servicio degrada a DEFAULT_RADIUS_CONFIG). */
  find(): Promise<PersistedRadiusConfig | null>;
  /** Abre una transacción de escritura y entrega el cliente tx al callback (upsert + outbox). */
  runInTx<T>(fn: (tx: RadiusConfigTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaDispatchRadiusConfigRepository implements DispatchRadiusConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(): Promise<PersistedRadiusConfig | null> {
    const row = await this.prisma.read.dispatchRadiusConfig.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (!row) return null;
    return {
      nearbyKRing: row.nearbyKRing,
      matchKRing: row.matchKRing,
      offerTimeoutMs: row.offerTimeoutMs,
      bidWindowSec: row.bidWindowSec,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: RadiusConfigTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as RadiusConfigTx));
  }
}
