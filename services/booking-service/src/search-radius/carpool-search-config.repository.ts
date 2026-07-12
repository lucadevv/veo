/**
 * Puerto + adaptador Prisma del SINGLETON carpool_search_config (espejo EXACTO del dispatch_radius_config de
 * dispatch-service · clean arch). El service depende de la INTERFAZ (CARPOOL_SEARCH_CONFIG_REPO), NO de
 * Prisma: así se testea con un repo en memoria y la persistencia real vive en el adaptador.
 *
 * El radio se guarda en KM (unidad del admin); el mapeo a k-ring H3 lo hace el service en runtime. El PUT
 * bumpea `version` (CAS) y encola el evento `booking.search_radius_config_updated` por OUTBOX en la MISMA
 * transacción del upsert (atomicidad estado↔evento, FOUNDATION §6).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const CARPOOL_SEARCH_CONFIG_REPO = Symbol('CARPOOL_SEARCH_CONFIG_REPO');

/** Id fijo del singleton (Tier 1 GLOBAL). */
export const SINGLETON_ID = 'GLOBAL';

/** Config persistida del radio de búsqueda + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedSearchConfig {
  /** Radio base de la búsqueda (km). Se mapea a k-ring H3 res-9 en runtime. */
  baseRadiusKm: number;
  /** Radio EXPANDIDO (km): la búsqueda reintenta con este si la base da 0 resultados. */
  expandRadiusKm: number;
  version: number;
  updatedAt: string;
}

/**
 * Cliente de transacción mínimo aceptado por `runInTx` (upsert + outbox en la MISMA tx). El upsert cubre el
 * primer write (fila inexistente) y el reemplazo; `outboxEvent.create` encola el evento del cambio de config.
 */
export interface SearchConfigTx {
  carpoolSearchConfig: {
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
export interface CarpoolSearchConfigRepository {
  /** Lee el singleton; `null` si la fila aún no existe (el servicio degrada al env — degradación honesta). */
  find(): Promise<PersistedSearchConfig | null>;
  /** Abre una transacción de escritura y entrega el cliente tx al callback (upsert + outbox). */
  runInTx<T>(fn: (tx: SearchConfigTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaCarpoolSearchConfigRepository implements CarpoolSearchConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(): Promise<PersistedSearchConfig | null> {
    const row = await this.prisma.read.carpoolSearchConfig.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (!row) return null;
    return {
      baseRadiusKm: row.baseRadiusKm,
      expandRadiusKm: row.expandRadiusKm,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: SearchConfigTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as SearchConfigTx));
  }
}
