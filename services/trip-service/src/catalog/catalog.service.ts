/**
 * CatalogService (ADR 013 §1.2 · puerta de escape) — overlay del catálogo de ofertas editable en
 * caliente. Patrón de singleton de config hot-editable (version + CAS + outbox + cache):
 *  - `getCatalog()`: GET interno — catálogo EFECTIVO (base de código ⟕ overlay DB) + version.
 *  - `resolveActive()`: ofertas ACTIVAS (lo que el quote cotiza / la teaser muestra / createTrip valida).
 *  - `replaceOverlay(...)`: PUT interno — REEMPLAZA wholesale el overlay, bumpea version, persiste +
 *    EMITE catalog.updated por outbox en la MISMA transacción.
 *
 * La resolución (base ⟕ overlay) es PURA (@veo/shared-types `resolveCatalog`/`activeOfferings`); este
 * servicio solo orquesta IO. El repo entra por puerto (clean arch). Cache in-proc de un slot (singleton)
 * como el del schedule: absorbe el read-heavy de createTrip/quote; el PUT lo invalida.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { ConflictError } from '@veo/utils';
import { bumpPricingConfigChanged } from '../trips/trip-metrics';
import {
  activeOfferings,
  resolveCatalog,
  type OfferingCatalogOverlay,
  type OfferingOverride,
  type ResolvedOffering,
} from '@veo/shared-types';
import {
  CATALOG_SINGLETON_ID,
  OFFERING_CATALOG_REPO,
  type OfferingCatalogRepository,
  type PersistedOverlay,
} from './catalog.repository';

const PRODUCER = 'trip-service';

/** Token DI (opcional) del TTL del cache; default 10s si el módulo no lo provee. */
export const OFFERING_CATALOG_CACHE_TTL_MS = Symbol('OFFERING_CATALOG_CACHE_TTL_MS');

/** Vista del catálogo efectivo que exponen el GET interno y el resultado del PUT. */
export interface CatalogView {
  version: number;
  updatedAt: string;
  /** Ofertas EFECTIVAS (base ⟕ overlay): lo que el quote/create/teaser consumen. */
  offerings: ResolvedOffering[];
  /** B2 · overlay CRUDO (lo que el admin tiene seteado explícitamente). El panel lo reenvía verbatim,
   *  upserteando solo la oferta tocada → el replace wholesale NO pisa los overrides de las demás. */
  overrides: OfferingOverride[];
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  /** Cache in-proc de un slot (singleton). SOLO lecturas exitosas; el PUT lo invalida. */
  private cache: { value: PersistedOverlay | null; expiresAt: number } | null = null;

  constructor(
    @Inject(OFFERING_CATALOG_REPO) private readonly repo: OfferingCatalogRepository,
    @Optional()
    @Inject(OFFERING_CATALOG_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
  ) {}

  /** GET interno: catálogo EFECTIVO (todas las ofertas con su `enabled`) + metadatos de versión. */
  async getCatalog(): Promise<CatalogView> {
    const persisted = await this.loadOverlay();
    return {
      version: persisted?.version ?? 0,
      updatedAt: persisted?.updatedAt ?? new Date(0).toISOString(),
      offerings: [...resolveCatalog(toOverlay(persisted))],
      overrides: persisted?.overrides ?? [],
    };
  }

  /** Ofertas ACTIVAS (las que el quote cotiza, la teaser muestra y createTrip acepta). */
  async resolveActive(): Promise<ResolvedOffering[]> {
    const persisted = await this.loadOverlay();
    return [...activeOfferings(toOverlay(persisted))];
  }

  /** ¿Esta oferta está habilitada AHORA? (createTrip lo usa para rechazar una oferta apagada). */
  async isEnabled(offeringId: string): Promise<boolean> {
    const active = await this.resolveActive();
    return active.some((offering) => offering.id === offeringId);
  }

  /**
   * La oferta EFECTIVA por id (base ⟕ overlay: enabled + pricing + `mode` efectivo), o undefined si no
   * existe en el catálogo de código. ADR 023: createTrip la usa para resolver pricing + modo en UNA lectura;
   * `resolveCatalog` ya aplicó `effectiveOfferingMode` (palanca manual del admin, respetando `modeLocked`).
   */
  async resolveOffering(offeringId: string): Promise<ResolvedOffering | undefined> {
    const persisted = await this.loadOverlay();
    return resolveCatalog(toOverlay(persisted)).find((offering) => offering.id === offeringId);
  }

  /**
   * PUT interno: REEMPLAZA wholesale el overlay, bumpea `version`, persiste + EMITE catalog.updated por
   * outbox en la MISMA tx. Idempotente en forma: re-enviar el mismo overlay deja el mismo estado.
   */
  async replaceOverlay(
    overrides: OfferingOverride[],
    expectedVersion: number,
  ): Promise<CatalogView> {
    const nextVersion = expectedVersion + 1;
    // B2 + ADR 023 §3: persistimos también mode/multiplier/minFareCents y los params por-servicio
    // (baseFareCents/perKmCents/perMinCents), solo los definidos → JSON limpio. El repo los re-parsea
    // defensivo y resolveCatalog los aplica/valida.
    const overridesJson = overrides.map((o) => normalizeOverride(o));

    const result = await this.repo.runInTx(async (tx) => {
      // Optimistic locking (CAS): el UPDATE solo pega si la versión vigente sigue siendo `expectedVersion`
      // (predicado bajo lock al escribir) → dos PUT concurrentes no se pisan (el 2º ve count=0 → 409).
      const updated = await tx.offeringCatalog.updateMany({
        where: { id: CATALOG_SINGLETON_ID, version: expectedVersion },
        data: { overrides: overridesJson, version: nextVersion },
      });

      let row: { version: number; updatedAt: Date };
      if (updated.count === 1) {
        const persisted = await tx.offeringCatalog.findUnique({
          where: { id: CATALOG_SINGLETON_ID },
        });
        if (!persisted) throw new ConflictError('el catálogo desapareció durante el reemplazo');
        row = persisted;
      } else if (expectedVersion === 0) {
        const existing = await tx.offeringCatalog.findUnique({
          where: { id: CATALOG_SINGLETON_ID },
        });
        if (existing) {
          throw new ConflictError(
            `el catálogo ya fue inicializado (v${existing.version}); recargá y reintentá`,
          );
        }
        row = await tx.offeringCatalog.create({
          data: { id: CATALOG_SINGLETON_ID, overrides: overridesJson, version: nextVersion },
        });
      } else {
        throw new ConflictError(
          `el catálogo cambió (esperabas v${expectedVersion}); recargá y reintentá`,
        );
      }
      // Outbox EN LA MISMA TX (FOUNDATION §6): audit + invalidación de cache en consumidores (public-bff).
      await tx.outboxEvent.create({
        data: {
          aggregateId: CATALOG_SINGLETON_ID,
          eventType: 'catalog.updated',
          envelope: createEnvelope({
            eventType: 'catalog.updated',
            producer: PRODUCER,
            payload: {
              overrides: overridesJson,
              version: row.version,
              updatedAt: row.updatedAt.toISOString(),
            },
          }),
        },
      });
      return row;
    });

    this.invalidateCache();
    bumpPricingConfigChanged('offering_catalog'); // OPS: señal de cambio de config (FOUNDATION §6)
    this.logger.log(
      `offering catalog REEMPLAZADO → version ${result.version} (${overrides.length} override(s)); ` +
        `catalog.updated emitido; cache invalidado`,
    );

    const overlay: OfferingCatalogOverlay = { overrides, version: result.version };
    return {
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
      offerings: [...resolveCatalog(overlay)],
      overrides,
    };
  }

  /**
   * Invalida el cache in-proc DE ESTA réplica. Lo llama el PUT local (mismo proceso) y, vía
   * PricingCacheConsumer, el evento `catalog.updated` que emite el PUT de CUALQUIER réplica →
   * invalidación instantánea cross-réplica, no acotada al TTL (que queda como fallback).
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /** Carga el overlay del repo (cacheado un slot). Miss/vencido → lee; cachea solo lecturas exitosas. */
  private async loadOverlay(): Promise<PersistedOverlay | null> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    const persisted = await this.repo.find();
    if (this.cacheTtlMs > 0) {
      this.cache = { value: persisted, expiresAt: now + this.cacheTtlMs };
    }
    return persisted;
  }
}

/** PersistedOverlay (con updatedAt) → OfferingCatalogOverlay (lo que la función pura necesita). */
function toOverlay(persisted: PersistedOverlay | null): OfferingCatalogOverlay | null {
  return persisted ? { overrides: persisted.overrides, version: persisted.version } : null;
}

/**
 * Normaliza un override para persistir: id + enabled siempre; mode/multiplier/minFareCents y los params
 * por-servicio (ADR 023 §3 · baseFareCents/perKmCents/perMinCents) SOLO si vienen definidos → JSON limpio.
 * Ojo: `0` es un valor VÁLIDO de perKmCents/perMinCents (Mecánico/Grúa no cobran distancia/tiempo), por eso
 * el guard es `!== undefined` y NO un truthy check (un `0` truthy-falso se perdería y caería al global).
 */
function normalizeOverride(o: OfferingOverride): Record<string, unknown> {
  return {
    id: o.id,
    enabled: o.enabled,
    ...(o.mode !== undefined ? { mode: o.mode } : {}),
    ...(o.multiplier !== undefined ? { multiplier: o.multiplier } : {}),
    ...(o.minFareCents !== undefined ? { minFareCents: o.minFareCents } : {}),
    ...(o.baseFareCents !== undefined ? { baseFareCents: o.baseFareCents } : {}),
    ...(o.perKmCents !== undefined ? { perKmCents: o.perKmCents } : {}),
    ...(o.perMinCents !== undefined ? { perMinCents: o.perMinCents } : {}),
  };
}
