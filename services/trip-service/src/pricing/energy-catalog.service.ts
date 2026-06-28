/**
 * EnergyCatalogService (B5) — catálogo de precios de energía por fuente, editable en caliente. Espeja
 * CatalogService/FuelSurchargeService (singleton + version + outbox + cache + CAS):
 *  - `getCatalog()`: GET interno (admin) — fuentes + precios + version.
 *  - `getPriceFor(source)`: el precio/unidad vigente de UNA fuente (céntimos), o null si no está cargada
 *    (degradación honesta: el consumidor del quote cae a 0/al fuel viejo). Cacheado un slot; el PUT invalida.
 *  - `replace(sources, expectedVersion)`: PUT interno — REEMPLAZA wholesale, CAS sobre `version`, persiste
 *    + EMITE energy.catalog_updated por outbox en la MISMA tx.
 *
 * B5-0: el catálogo se construye y se siembra (GASOLINE_90 = precio global actual), pero NO se cablea aún
 * a la fórmula de tarifa — eso es B5-1 (con shadow-compare). Acá solo vive el motor + la lectura.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { ConflictError, ValidationError } from '@veo/utils';
import type { EnergySource, EnergySourcePrice } from '@veo/shared-types';
import { bumpPricingConfigChanged } from '../trips/trip-metrics';
import { missingRequiredSources } from './energy-requirements';
import type { Env } from '../config/env.schema';
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
  /**
   * ¿Es este catálogo (B5) el modelo de energía VIVO hoy? = flag PRICING_ENERGY_MODEL_ENABLED ON.
   * El admin necesita saberlo: con el flag OFF, editar el catálogo NO mueve la tarifa (la fija el
   * recargo de combustible B4) — el panel lo refleja como "Vista previa". Inverso de FuelSurcharge.active.
   */
  active: boolean;
}

@Injectable()
export class EnergyCatalogService {
  private readonly logger = new Logger(EnergyCatalogService.name);

  /** Cache in-proc de un slot (singleton). SOLO lecturas exitosas; el PUT lo invalida. */
  private cache: {
    sources: EnergySourcePrice[];
    version: number;
    updatedAt: string;
    expiresAt: number;
  } | null = null;

  constructor(
    @Inject(ENERGY_CATALOG_REPO) private readonly repo: EnergyCatalogRepository,
    @Optional()
    @Inject(ENERGY_CATALOG_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
    // F2.1b · para gatear la guarda de completitud del replace() según el flip. @Optional: tests legacy
    // construyen sin config (flip OFF → sin restricción, como en producción pre-flip).
    @Optional() private readonly config?: ConfigService<Env, true>,
  ) {}

  /** Carga el catálogo del repo (cacheado un slot). Miss/vencido → lee; cachea solo lecturas exitosas. */
  private async load(): Promise<{
    sources: EnergySourcePrice[];
    version: number;
    updatedAt: string;
  }> {
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

  /**
   * ¿Es este catálogo (B5) el modelo de energía VIVO hoy? = flag PRICING_ENERGY_MODEL_ENABLED ON.
   * Único punto que lee el flag para señalar `active` (GET + PUT). El flag ya está inyectado (@Optional)
   * para la guarda de completitud del replace(); lo reusamos. Sin config (tests legacy) → false (OFF).
   */
  private isLiveModel(): boolean {
    return this.config?.get('PRICING_ENERGY_MODEL_ENABLED') ?? false;
  }

  /** GET interno: catálogo vigente (fuentes + precios + version) + si este modelo está vivo (flag ON). */
  async getCatalog(): Promise<EnergyCatalogView> {
    const { sources, version, updatedAt } = await this.load();
    return { sources, version, updatedAt, active: this.isLiveModel() };
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
    // F2.1b · con el flip ON, un PUT no puede dejar el catálogo incompleto: el create autoritativo lanzaría
    // InvalidStateError para las ofertas cuya fuente quedó sin precio → caída de creación de viajes. Guardamos
    // la MUTACIÓN (misma regla que el boot-guard), rechazando ANTES de persistir. Flip OFF → sin restricción.
    if (this.config?.get('PRICING_ENERGY_MODEL_ENABLED')) {
      const missing = missingRequiredSources(new Set<EnergySource>(sources.map((s) => s.sourceId)));
      if (missing.length > 0) {
        throw new ValidationError(
          'El modelo de energía está activo: el catálogo debe incluir un precio para todas las fuentes de ' +
            'las ofertas visibles. Faltan fuentes — agregalas antes de guardar.',
          { missingSources: missing },
        );
      }
    }
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
        const persisted = await tx.energyCatalog.findUnique({
          where: { id: ENERGY_CATALOG_SINGLETON_ID },
        });
        if (!persisted)
          throw new ConflictError('el catálogo de energía desapareció durante el reemplazo');
        row = persisted;
      } else if (expectedVersion === 0) {
        const existing = await tx.energyCatalog.findUnique({
          where: { id: ENERGY_CATALOG_SINGLETON_ID },
        });
        if (existing) {
          throw new ConflictError(
            `el catálogo de energía ya fue inicializado (v${existing.version}); recargá y reintentá`,
          );
        }
        row = await tx.energyCatalog.create({
          data: { id: ENERGY_CATALOG_SINGLETON_ID, sources: sourcesJson, version: nextVersion },
        });
      } else {
        throw new ConflictError(
          `el catálogo de energía cambió (esperabas v${expectedVersion}); recargá y reintentá`,
        );
      }

      await tx.outboxEvent.create({
        data: {
          aggregateId: ENERGY_CATALOG_SINGLETON_ID,
          eventType: 'energy.catalog_updated',
          envelope: createEnvelope({
            eventType: 'energy.catalog_updated',
            producer: PRODUCER,
            payload: {
              sources: sourcesJson,
              version: row.version,
              updatedAt: row.updatedAt.toISOString(),
            },
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
      active: this.isLiveModel(),
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
