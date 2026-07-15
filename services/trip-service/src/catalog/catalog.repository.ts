/**
 * Puerto + adaptador Prisma del SINGLETON offering_catalog (ADR 013 §1.2 · clean arch). Espeja
 * `PrismaPricingScheduleRepository`: el CatalogService depende de la INTERFAZ (OFFERING_CATALOG_REPO),
 * no de Prisma. El overlay se testea con un repo en memoria; la persistencia vive en el adaptador.
 */
import { Injectable } from '@nestjs/common';
import { PricingMode, type OfferingOverride } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz). */
export const OFFERING_CATALOG_REPO = Symbol('OFFERING_CATALOG_REPO');

/** Id fijo del singleton (un solo overlay global). */
export const CATALOG_SINGLETON_ID = 'GLOBAL';

/** Overlay persistido + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedOverlay {
  overrides: OfferingOverride[];
  version: number;
  updatedAt: string;
}

/**
 * Cliente de transacción mínimo aceptado por `replace` (overlay + outbox en la MISMA tx).
 * Optimistic locking (CAS): `updateMany` con `version` en el WHERE → el predicado se evalúa bajo lock al
 * escribir, así dos PUT concurrentes NO pueden ambos bumpear desde la misma versión (el 2º ve count=0).
 * `create` cubre el primer write (sin fila); `findUnique` relee la fila escrita para el `updatedAt`.
 */
export interface CatalogTx {
  offeringCatalog: {
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
export interface OfferingCatalogRepository {
  /** Lee el singleton; `null` si la fila no existe (el servicio degrada a "todas habilitadas"). */
  find(): Promise<PersistedOverlay | null>;
  /** Abre una transacción de escritura (replace wholesale + outbox). */
  runInTx<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaOfferingCatalogRepository implements OfferingCatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(): Promise<PersistedOverlay | null> {
    const row = await this.prisma.read.offeringCatalog.findUnique({
      where: { id: CATALOG_SINGLETON_ID },
    });
    if (!row) return null;
    return {
      overrides: parseOverrides(row.overrides),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as CatalogTx));
  }
}

/**
 * Parsea DEFENSIVAMENTE el `overrides` JSON de la fila a OfferingOverride[]. Sin `any`: estrecha cada
 * elemento. Una fila corrupta degrada a [] (honesto, no crash); además el PUT valida el shape antes de
 * escribir y `resolveCatalog` ignora ids que no estén en el catálogo de código (cinturón y tirantes).
 * B2: los campos opcionales (mode/multiplier/minFareCents) se estrechan uno a uno; un valor inválido se
 * OMITE (no rompe la fila) — el override queda como si no lo trajera, y `resolveCatalog` cae al de código.
 * ADR 023 §3: ídem para los params por-servicio (baseFareCents/perKmCents/perMinCents). Ojo: `0` es un valor
 * VÁLIDO de perKmCents/perMinCents (Mecánico/Grúa) — el guard es `>= 0`, no truthy, para no perder el `0`.
 */
function parseOverrides(raw: Prisma.JsonValue): OfferingOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: OfferingOverride[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const { id, enabled, mode, multiplier, minFareCents, baseFareCents, perKmCents, perMinCents } =
      rec;
    if (typeof id === 'string' && typeof enabled === 'boolean') {
      const ov: OfferingOverride = { id: id as OfferingOverride['id'], enabled };
      if (mode === PricingMode.PUJA || mode === PricingMode.FIXED) ov.mode = mode;
      if (typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier > 0) {
        ov.multiplier = multiplier;
      }
      if (typeof minFareCents === 'number' && Number.isInteger(minFareCents) && minFareCents >= 0) {
        ov.minFareCents = minFareCents;
      }
      if (typeof baseFareCents === 'number' && Number.isInteger(baseFareCents) && baseFareCents >= 0) {
        ov.baseFareCents = baseFareCents;
      }
      if (typeof perKmCents === 'number' && Number.isInteger(perKmCents) && perKmCents >= 0) {
        ov.perKmCents = perKmCents;
      }
      if (typeof perMinCents === 'number' && Number.isInteger(perMinCents) && perMinCents >= 0) {
        ov.perMinCents = perMinCents;
      }
      out.push(ov);
    }
  }
  return out;
}
