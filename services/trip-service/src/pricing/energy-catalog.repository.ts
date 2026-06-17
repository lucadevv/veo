/**
 * Puerto + adaptador Prisma del SINGLETON energy_catalog (B5 · clean arch). Espeja
 * PrismaOfferingCatalogRepository: el EnergyCatalogService depende de la INTERFAZ (ENERGY_CATALOG_REPO),
 * no de Prisma. El catálogo es un singleton que guarda un ARRAY de precios por fuente de energía
 * { sourceId, unit, pricePerUnitCents } — el quote/economía derivan el costo/km = precio ÷ rendimiento.
 *
 * Optimistic locking (CAS) idéntico a fuel/catalog: `updateMany` con `version` en el WHERE (predicado
 * bajo lock al escribir), `create` para el primer write, `findUnique` para releer el `updatedAt`.
 */
import { Injectable } from '@nestjs/common';
import { EnergySource, ENERGY_SOURCE_UNIT, type EnergySourcePrice } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';

// Contrato compartido productor(trip-service)↔consumidor(admin-bff): EnergySourcePrice vive en
// @veo/shared-types (junto a EnergySource/EnergyUnit). Se re-exporta acá por compatibilidad con los
// consumidores internos que ya lo importaban del repo.
export type { EnergySourcePrice };

/** Token DI del puerto (inyección por interfaz). */
export const ENERGY_CATALOG_REPO = Symbol('ENERGY_CATALOG_REPO');

/** Id fijo del singleton (un solo catálogo global). */
export const ENERGY_CATALOG_SINGLETON_ID = 'GLOBAL';

/** Catálogo persistido + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedEnergyCatalog {
  sources: EnergySourcePrice[];
  version: number;
  updatedAt: string;
}

/**
 * Cliente de transacción mínimo aceptado por `replace` (catálogo + outbox en la MISMA tx).
 * CAS: updateMany con version en el WHERE; create para el primer write; findUnique para releer.
 */
export interface EnergyCatalogTx {
  energyCatalog: {
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
export interface EnergyCatalogRepository {
  /** Lee el singleton; `null` si la fila no existe (el servicio degrada a "sin precios" → costo 0). */
  find(): Promise<PersistedEnergyCatalog | null>;
  /** Abre una transacción de escritura (replace wholesale + outbox). */
  runInTx<T>(fn: (tx: EnergyCatalogTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class PrismaEnergyCatalogRepository implements EnergyCatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(): Promise<PersistedEnergyCatalog | null> {
    const row = await this.prisma.read.energyCatalog.findUnique({
      where: { id: ENERGY_CATALOG_SINGLETON_ID },
    });
    if (!row) return null;
    return {
      sources: parseSources(row.sources),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: EnergyCatalogTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as EnergyCatalogTx));
  }
}

/**
 * Parsea DEFENSIVAMENTE el `sources` JSON a EnergySourcePrice[]. Sin `any`: estrecha cada elemento.
 * Una fila/elemento corrupto se OMITE (degradación honesta, no crash). La `unit` se NORMALIZA a la
 * canónica de la fuente (ENERGY_SOURCE_UNIT) — el admin no puede declarar gasolina en kWh. Un sourceId
 * desconocido o precio inválido (no-entero/negativo) se descarta. El PUT re-valida antes de escribir.
 */
function parseSources(raw: Prisma.JsonValue): EnergySourcePrice[] {
  if (!Array.isArray(raw)) return [];
  const out: EnergySourcePrice[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const { sourceId, pricePerUnitCents } = rec;
    if (typeof sourceId !== 'string' || !(sourceId in ENERGY_SOURCE_UNIT)) continue;
    if (seen.has(sourceId)) continue; // una fuente no puede aparecer dos veces (ambiguo)
    if (typeof pricePerUnitCents !== 'number' || !Number.isInteger(pricePerUnitCents) || pricePerUnitCents < 0) {
      continue;
    }
    const src = sourceId as EnergySource;
    seen.add(sourceId);
    out.push({ sourceId: src, unit: ENERGY_SOURCE_UNIT[src], pricePerUnitCents });
  }
  return out;
}
