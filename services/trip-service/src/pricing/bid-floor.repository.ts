/**
 * Puerto + adaptador Prisma del SINGLETON bid_floor_config (ADR 010 §9.3 · clean arch). Espeja
 * PrismaFuelSurchargeRepository: el BidFloorService depende de la INTERFAZ (BID_FLOOR_REPO), no de Prisma
 * — se testea con un repo en memoria; la persistencia vive en el adaptador.
 *
 * La config es { defaultFloorCents, overrides[] } (Tier 1 GLOBAL; per-zona = no-breaking). `overrides` es
 * un array JSON { zone, offeringId, floorCents } que se parsea DEFENSIVAMENTE (fila corrupta → []).
 */
import { Injectable } from '@nestjs/common';
import { findOffering, GLOBAL_ZONE, type BidFloorConfig, type BidFloorOverride } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz). */
export const BID_FLOOR_REPO = Symbol('BID_FLOOR_REPO');

/** Id fijo del singleton (Tier 1 GLOBAL). */
export const BID_FLOOR_SINGLETON_ID = 'GLOBAL';

/** Config persistida del piso + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedBidFloor extends BidFloorConfig {
  version: number;
  updatedAt: string;
}

/**
 * Cliente de transacción mínimo aceptado por `replace` (config + outbox en la MISMA tx).
 * Optimistic locking (CAS): `updateMany` con `version` en el WHERE → el predicado se evalúa bajo lock al
 * escribir, así dos PUT concurrentes NO pueden ambos bumpear desde la misma versión (el 2º ve count=0).
 * `create` cubre el primer write (sin fila); `findUnique` relee la fila escrita para el `updatedAt`.
 */
export interface BidFloorTx {
  bidFloorConfig: {
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
export interface BidFloorRepository {
  /** Lee el singleton; `null` si la fila aún no existe (el servicio degrada a DEFAULT_BID_FLOOR_CONFIG). */
  find(): Promise<PersistedBidFloor | null>;
  /** Abre una transacción de escritura (replace + outbox). */
  runInTx<T>(fn: (tx: BidFloorTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaBidFloorRepository implements BidFloorRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(): Promise<PersistedBidFloor | null> {
    const row = await this.prisma.read.bidFloorConfig.findUnique({ where: { id: BID_FLOOR_SINGLETON_ID } });
    if (!row) return null;
    return {
      defaultFloorCents: row.defaultFloorCents,
      overrides: parseOverrides(row.overrides),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: BidFloorTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as BidFloorTx));
  }
}

/**
 * Parsea de forma DEFENSIVA el `overrides` JSON de la fila (Prisma.JsonValue) a BidFloorOverride[]. Sin `any`:
 * estrechamos cada elemento. Una fila corrupta/forma inesperada degrada a [] (honesto, no crash) — el PUT
 * valida el shape antes de escribir, así que esto es cinturón-y-tirantes. `zone` se acota a 'GLOBAL' (Tier 1).
 */
function parseOverrides(raw: Prisma.JsonValue): BidFloorOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: BidFloorOverride[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const { zone, offeringId, floorCents } = rec;
    // Un id de oferta que ya no existe en código se IGNORA (el código es la fuente de ids válidos, igual
    // que `resolveCatalog`). `findOffering` además NARROWING string → OfferingId tipado.
    const spec = typeof offeringId === 'string' ? findOffering(offeringId) : undefined;
    if (zone === GLOBAL_ZONE && spec && typeof floorCents === 'number') {
      out.push({ zone, offeringId: spec.id, floorCents });
    }
  }
  return out;
}
