/**
 * CostPerKmService (F2.5 · ADR-017 §1.4) — resuelve el COSTO/KM (céntimos Int) que alimenta el tope legal
 * de cost-sharing (CostCapService), unificándolo con el on-demand. Antes el carpooling usaba un costo/km
 * FLAT de env ("PROVISIONAL", sin clase, sin energía viva); ahora deriva del MISMO precio de energía vivo
 * que trip-service, vía la MISMA fórmula compartida (`deriveCostPerKmCents` de @veo/shared-types).
 *
 *   costo/km = precioGasolina90 (vivo, EnergyCatalog de trip-service) ÷ rendimiento del económico (ref. legal)
 *
 * MICROSERVICIOS DESACOPLADOS: booking NO comparte DB ni hace join cross-service — LEE el precio por el
 * endpoint INTERNO firmado de trip-service (GET /internal/pricing/energy-catalog), HMAC identidad
 * `service-rail` (mismo patrón que public-bff→trip de MapsService). Cache de UN slot, TTL corto, invalidado
 * por el evento `energy.catalog_updated` (PricingCacheConsumer).
 *
 * DEGRADACIÓN HONESTA (NUNCA rompe el publish): si trip-service no responde, o no hay precio de GASOLINE_90,
 * o la derivación da 0 → cae al env `COST_PER_KM_CENTS_PE/EC` (el comportamiento histórico). El gate legal
 * F1b sigue corriendo, solo que con el costo/km provisional en vez del vivo.
 *
 * MULTIPAÍS: hoy el EnergyCatalog es de PE (energía aún NO es per-país). Solo PE deriva del precio vivo; EC
 * usa SIEMPRE su env hasta F8 (energía real per-país). Aplicar el precio de gasolina peruano a EC sería
 * incorrecto, así que EC NO toca el catálogo vivo.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { anonymousIdentity, type AuthenticatedUser } from '@veo/auth';
import { ValidationError } from '@veo/utils';
import type { InternalRestClient } from '@veo/rpc';
import { CARPOOLING_COST_REFERENCE, deriveCostPerKmCents } from '@veo/shared-types';
import {
  costPerKmCentsFor,
  isPais,
  PAIS,
  type CostPerKmConfig,
} from '../domain/cost-cap';
import { bumpCostPerKmDegraded } from './cost-cap-metrics';

/** Token DI del cliente REST interno firmado hacia trip-service (provisto por el módulo). */
export const TRIP_REST_CLIENT = Symbol('TRIP_REST_CLIENT');

/** Token DI (opcional) del TTL del cache; default 10s — espeja EnergyCatalogService de trip-service. */
export const COST_PER_KM_CACHE_TTL_MS = Symbol('COST_PER_KM_CACHE_TTL_MS');

/** Shape del GET /internal/pricing/energy-catalog de trip-service (contrato interno, B5). */
interface EnergyCatalogReply {
  sources: { sourceId: string; unit: string; pricePerUnitCents: number }[];
  version: number;
  updatedAt: string;
}

/**
 * Identidad de SISTEMA con la que booking firma la lectura interna de pricing: no hay usuario final detrás
 * (es config de plataforma), riel `service-rail` (decidido en la construcción del InternalRestClient).
 * `anonymousIdentity('driver')` = sin sesión real, igual que GrpcIdentityClient para los gates de elegibilidad.
 */
const SYSTEM_IDENTITY: AuthenticatedUser = anonymousIdentity('driver');

@Injectable()
export class CostPerKmService {
  private readonly logger = new Logger(CostPerKmService.name);

  /** Cache in-proc de un slot: el costo/km PE derivado del precio vivo. El evento/TTL lo invalidan. */
  private cache: { costPerKmCents: number; expiresAt: number } | null = null;

  constructor(
    @Inject(TRIP_REST_CLIENT) private readonly tripRest: InternalRestClient,
    @Inject('COST_PER_KM_CONFIG') private readonly config: CostPerKmConfig,
    @Inject(COST_PER_KM_CACHE_TTL_MS) private readonly cacheTtlMs: number = 10_000,
  ) {}

  /**
   * Costo/km (céntimos Int) para el país. PE → derivado del precio VIVO de GASOLINE_90 (degrada a env);
   * EC → env (energía aún no es per-país, F8). País no soportado → ValidationError tipado (igual contrato
   * que `costPerKmCentsFor`: publicar para un país sin tarifa es estado inválido, no un fallback silencioso).
   */
  async getCostPerKmCents(pais: string): Promise<number> {
    if (!isPais(pais)) {
      throw new ValidationError('País no soportado para el cálculo del tope de cost-sharing', { pais });
    }
    // EC (y cualquier país ≠ PE) usa su env hasta F8: el EnergyCatalog vivo es de PE.
    if (pais !== PAIS.PE) {
      return costPerKmCentsFor(pais, this.config);
    }
    const live = await this.resolveLivePeCostPerKmCents();
    // Derivación válida (>0) → el costo/km vivo; si no, el env PE (degradación honesta, nunca rompe publish).
    return live ?? costPerKmCentsFor(PAIS.PE, this.config);
  }

  /**
   * Costo/km PE derivado del precio VIVO de GASOLINE_90 (cacheado un slot), o `null` si no se pudo:
   * trip-service caído, fuente sin precio cargado, o derivación degenerada (0). `null` señala "usá el env".
   */
  private async resolveLivePeCostPerKmCents(): Promise<number | null> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.costPerKmCents;

    const price = await this.fetchGasoline90PriceCents();
    if (price === null) return null;

    // FUENTE ÚNICA de la fórmula (@veo/shared-types): precio ÷ rendimiento del económico (ref. legal).
    const costPerKmCents = deriveCostPerKmCents(price, CARPOOLING_COST_REFERENCE.efficiencyKmPerUnit);
    if (costPerKmCents <= 0) {
      // Derivación degenerada (precio 0 / rendimiento inválido) → no es un costo/km usable; cae al env.
      bumpCostPerKmDegraded('degenerate');
      this.logger.warn(
        `costo/km vivo PE derivó ${costPerKmCents} (precio=${price}); usando el env COST_PER_KM_CENTS_PE`,
      );
      return null;
    }
    if (this.cacheTtlMs > 0) {
      this.cache = { costPerKmCents, expiresAt: now + this.cacheTtlMs };
    }
    return costPerKmCents;
  }

  /**
   * Precio vivo (céntimos/L) de GASOLINE_90 desde trip-service. `null` ante CUALQUIER falla (red/timeout/
   * 5xx) o si la fuente no está en el catálogo → el caller degrada al env. NO lanza: el costo/km vivo es un
   * refinamiento, su ausencia jamás debe tumbar el publish del carpooling.
   */
  private async fetchGasoline90PriceCents(): Promise<number | null> {
    try {
      const reply = await this.tripRest.get<EnergyCatalogReply>('/internal/pricing/energy-catalog', {
        identity: SYSTEM_IDENTITY,
      });
      // FUENTE de energía de la REFERENCIA legal (no hardcodeada): si mañana se afina la energía del
      // económico (CARPOOLING_COST_REFERENCE), el precio y el rendimiento siguen DE LA MISMA oferta — la
      // "fuente única" no se rompe. Hoy = GASOLINE_90 (offerings.ts), pero el acoplamiento queda parametrizado.
      const price = reply.sources.find(
        (s) => s.sourceId === CARPOOLING_COST_REFERENCE.energySource,
      )?.pricePerUnitCents;
      if (price === undefined || !Number.isFinite(price)) {
        bumpCostPerKmDegraded('no_price');
        this.logger.warn(
          'EnergyCatalog sin precio de la fuente de referencia; tope de cost-sharing con el env COST_PER_KM_CENTS_PE (F2.5 · degradación honesta)',
        );
        return null;
      }
      return price;
    } catch (err) {
      // Counter alertable: un valor SOSTENIDO distingue un misconfig PERMANENTE (URL/HMAC/404) del escudo
      // legal de un corte transitorio de trip-service — el env es placeholder NO validado por legal.
      bumpCostPerKmDegraded('trip_unreachable');
      this.logger.warn(
        `precio de energía no disponible (${(err as Error).message}); tope de cost-sharing con el env COST_PER_KM_CENTS_PE (F2.5 · degradación honesta)`,
      );
      return null;
    }
  }

  /**
   * Invalida el cache in-proc DE ESTA réplica. Lo llama el PricingCacheConsumer al recibir
   * `energy.catalog_updated` (que emite el PUT del EnergyCatalog en trip-service) → el nuevo precio se ve
   * de inmediato cross-réplica, sin esperar el TTL (que queda de fallback). Idempotente y barato.
   */
  invalidateCache(): void {
    this.cache = null;
  }
}
