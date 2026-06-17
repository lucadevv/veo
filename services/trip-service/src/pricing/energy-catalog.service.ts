/**
 * EnergyCatalogService (B5) — catálogo de precios de energía por fuente, editable en caliente. Espeja
 * CatalogService/FuelSurchargeService (singleton + version + outbox + cache + CAS):
 *  - `getCatalog()`: GET interno (admin) — fuentes + precios + version.
 *  - `getPriceFor(source)`: el precio/unidad vigente de UNA fuente (céntimos), o null si no está cargada
 *    (degradación honesta: el consumidor del quote cae a 0/al fuel viejo). Cacheado un slot; el PUT invalida.
 *  - `replace(sources, expectedVersion)`: PUT interno — REEMPLAZA wholesale, CAS sobre `version`, persiste
 *    + EMITE energy.catalog_updated por outbox en la MISMA tx.
 *
 * B5-0: el catálogo se construye y se siembra (GASOLINE_95 = precio global actual), pero NO se cablea aún
 * a la fórmula de tarifa — eso es B5-1 (con shadow-compare). Acá solo vive el motor + la lectura.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { ConflictError } from '@veo/utils';
import type { EnergySource, EnergySourcePrice } from '@veo/shared-types';
import { bumpPricingConfigChanged } from '../trips/trip-metrics';
import {
  ENERGY_CATALOG_REPO,
  ENERGY_CATALOG_SINGLETON_ID,
  type EnergyCatalogRepository,
} from './energy-catalog.repository';

const PRODUCER = 'trip-service';

/** Token DI (opcional) del TTL del cache; default 10s si el módulo no lo provee. */
export const ENERGY_CATALOG_CACHE_TTL_MS = Symbol('ENERGY_CATALOG_CACHE_TTL_MS');

/** Vista del catálogo de energía que exponen el GET interno y el resultado del PUT. */
export interface EnergyCatalogView {
  sources: EnergySourcePrice[];
  version: number;
  updatedAt: string;
}

@Injectable()
export class EnergyCatalogService {
  private readonly logger = new Logger(EnergyCatalogService.name);

  /** Cache in-proc de un slot (singleton). SOLO lecturas exitosas; el PUT lo invalida. */
  private cache: { sources: EnergySourcePrice[]; version: number; updatedAt: string; expiresAt: number } | null = null;

  constructor(
    @Inject(ENERGY_CATALOG_REPO) private readonly repo: EnergyCatalogRepository,
    @Optional()
    @Inject(ENERGY_CATALOG_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
  ) {}

  /** Carga el catálogo del repo (cacheado un slot). Miss/vencido → lee; cachea solo lecturas exitosas. */
  private async load(): Promise<{ sources: EnergySourcePrice[]; version: number; updatedAt: string }> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache;

    const persisted = await this.repo.find();
    const value = {
      sources: persisted?.sources ?? [],
      version: persisted?.version ?? 0,
      updatedAt: persisted?.updatedAt ?? new Date(0).toISOString(),
    };
    if (this.cacheTtlMs > 0) {
      this.cache = { ...value, expiresAt: now + this.cacheTtlMs };
    }
    return value;
  }

  /** GET interno: catálogo vigente (fuentes + precios + version). */
  async getCatalog(): Promise<EnergyCatalogView> {
    const { sources, version, updatedAt } = await this.load();
    return { sources, version, updatedAt };
  }

  /**
   * Precio/unidad vigente (céntimos PEN) de una fuente, o `null` si no está cargada. El consumidor del
   * quote (B5-1) deriva el costo/km = precio ÷ rendimiento; `null` → degrada honesto (sin recargo de esa
   * fuente). NO lanza: una fuente faltante es config incompleta, no un error.
   */
  async getPriceFor(source: EnergySource): Promise<number | null> {
    const { sources } = await this.load();
    return sources.find((s) => s.sourceId === source)?.pricePerUnitCents ?? null;
  }

  /**
   * PUT interno: REEMPLAZA wholesale el catálogo, CAS sobre `version`, persiste + EMITE
   * energy.catalog_updated por outbox en la MISMA tx. `sources` ya viene validado por el DTO; el repo
   * re-parsea defensivo (normaliza unit, descarta corruptos).
   */
  async replace(sources: EnergySourcePrice[], expectedVersion: number): Promise<EnergyCatalogView> {
    const nextVersion = expectedVersion + 1;
    const sourcesJson = sources.map((s) => ({
      sourceId: s.sourceId,
      unit: s.unit,
      pricePerUnitCents: s.pricePerUnitCents,
    }));

    const result = await this.repo.runInTx(async (tx) => {
      // CAS: el UPDATE solo pega si la versión vigente sigue siendo `expectedVersion` (predicado bajo lock).
      const updated = await tx.energyCatalog.updateMany({
        where: { id: ENERGY_CATALOG_SINGLETON_ID, version: expectedVersion },
        data: { sources: sourcesJson, version: nextVersion },
      });

      let row: { version: number; updatedAt: Date };
      if (updated.count === 1) {
        const persisted = await tx.energyCatalog.findUnique({ where: { id: ENERGY_CATALOG_SINGLETON_ID } });
        if (!persisted) throw new ConflictError('el catálogo de energía desapareció durante el reemplazo');
        row = persisted;
      } else if (expectedVersion === 0) {
        const existing = await tx.energyCatalog.findUnique({ where: { id: ENERGY_CATALOG_SINGLETON_ID } });
        if (existing) {
          throw new ConflictError(`el catálogo de energía ya fue inicializado (v${existing.version}); recargá y reintentá`);
        }
        row = await tx.energyCatalog.create({
          data: { id: ENERGY_CATALOG_SINGLETON_ID, sources: sourcesJson, version: nextVersion },
        });
      } else {
        throw new ConflictError(`el catálogo de energía cambió (esperabas v${expectedVersion}); recargá y reintentá`);
      }

      await tx.outboxEvent.create({
        data: {
          aggregateId: ENERGY_CATALOG_SINGLETON_ID,
          eventType: 'energy.catalog_updated',
          envelope: createEnvelope({
            eventType: 'energy.catalog_updated',
            producer: PRODUCER,
            payload: { sources: sourcesJson, version: row.version, updatedAt: row.updatedAt.toISOString() },
          }),
        },
      });
      return row;
    });

    this.invalidateCache();
    bumpPricingConfigChanged('energy_catalog'); // OPS: señal de cambio de config (FOUNDATION §6)
    this.logger.log(
      `energy catalog REEMPLAZADO → version ${result.version} (${sources.length} fuente(s)); ` +
        `energy.catalog_updated emitido; cache invalidado`,
    );
    return {
      sources,
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  /**
   * Invalida el cache in-proc DE ESTA réplica. Lo llama el PUT local (mismo proceso) y, vía
   * PricingCacheConsumer, el evento `energy.catalog_updated` que emite el PUT de CUALQUIER réplica
   * → invalidación instantánea cross-réplica, no acotada al TTL (que queda como fallback).
   */
  invalidateCache(): void {
    this.cache = null;
  }
}
