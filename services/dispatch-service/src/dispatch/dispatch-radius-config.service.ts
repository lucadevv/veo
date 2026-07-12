/**
 * DispatchRadiusConfigService — config SINGLETON de RADIOS + VENTANAS de dispatch editable en runtime por
 * el admin. Espejo EXACTO del PricingScheduleService del trip-service (ADR 011): cache in-proc de UN slot
 * (TTL configurable), GET, PUT que bumpea `version` + persiste + emite outbox en la MISMA tx, e invalida
 * el cache. El repo entra por PUERTO (DISPATCH_RADIUS_CONFIG_REPO) — clean arch: el service no conoce Prisma.
 *
 * Consumidores del hot-path leen el snapshot cacheado en runtime, sin reiniciar el servicio al cambiar:
 *  - `getKRings()`  → k-rings (NearbyDriversService feed de mapa, OfferBoardService broadcast de pujas).
 *  - `getWindows()` → ventanas (MatchingService oferta directa FIXED, OfferBoardService reopenBoard PUJA).
 * Ambos comparten UN solo slot de cache (`getSnapshot`): la fila cambia en el orden de HORAS.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { Prisma } from '../generated/prisma';
import {
  DISPATCH_RADIUS_CONFIG_REPO,
  SINGLETON_ID,
  type DispatchRadiusConfigRepository,
  type PersistedRadiusConfig,
} from './dispatch-radius-config.repository';
import type { DispatchPolicy, DispatchPolicyV2 } from './dispatch-policy';

const PRODUCER = 'dispatch-service';

/** Nombre del evento de outbox del cambio de config (const tipada, NUNCA string suelto · §4-ter). */
export const DISPATCH_RADIUS_CONFIG_UPDATED = 'dispatch.radius_config_updated' as const;

/**
 * DEFAULTS tipados (degradación honesta §8.2): sin fila el service devuelve ESTO con version 0, no crash.
 * `nearbyKRing=3` (feed de mapa), `matchKRing=4` (broadcast de pujas), `offerTimeoutMs=12000` (oferta
 * directa FIXED) y `bidWindowSec=60` (board de PUJA). NO son magic numbers sueltos. Las VENTANAS son
 * además el fallback último (tests / sin DI): en runtime el módulo SIEMBRA estos defaults desde el env
 * (DISPATCH_OFFER_TIMEOUT_MS / BID_WINDOW_SEC) vía DISPATCH_WINDOW_DEFAULTS.
 */
export const DEFAULT_RADIUS_CONFIG = {
  nearbyKRing: 3,
  matchKRing: 4,
  offerTimeoutMs: 20_000, // ADR-021 Fase F (F2) — 12s→20s (default; admin-configurable)
  bidWindowSec: 60,
} as const;

/** k-rings vigentes (lo que el hot-path geoespacial consume). */
export interface KRings {
  nearbyKRing: number;
  matchKRing: number;
}

/** Ventanas de dispatch vigentes (oferta directa FIXED + board de PUJA). */
export interface DispatchWindows {
  /** Ventana (ms) de la oferta directa FIXED antes de TIMEOUT + avanzar. */
  offerTimeoutMs: number;
  /** Ventana (s) del board de PUJA (openBoard/reopenBoard). */
  bidWindowSec: number;
}

/** Política de despacho vigente (feature-flag + snapshot v2 parseado) que sirve `getPolicy()`. */
interface DispatchPolicySlot {
  policyVersion: string;
  policyV2: DispatchPolicyV2 | null;
}

/**
 * Snapshot combinado (radios + ventanas + política) que se cachea en UN solo slot y sirve a los getters
 * (getKRings/getWindows/getPolicy). Un solo `find()` alimenta a los tres: la fila cambia en orden de HORAS.
 */
type DispatchConfigSnapshot = KRings & DispatchWindows & DispatchPolicySlot;

/** Token DI del TTL (ms) del cache de la config; lo provee el módulo. */
export const DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS = Symbol('DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS');

/**
 * Token DI de los DEFAULTS de las VENTANAS, SEMBRADOS desde el env por el módulo
 * (DISPATCH_OFFER_TIMEOUT_MS / BID_WINDOW_SEC). Es el rol "env = seed del default de la DB": sin fila en
 * la DB el service degrada a ESTOS valores. Sin provider (tests) cae al DEFAULT_RADIUS_CONFIG.
 */
export const DISPATCH_WINDOW_DEFAULTS = Symbol('DISPATCH_WINDOW_DEFAULTS');

@Injectable()
export class DispatchRadiusConfigService {
  private readonly logger = new Logger(DispatchRadiusConfigService.name);

  /**
   * Cache in-proc de UN solo slot del snapshot (radios + ventanas), espejo del cache del
   * PricingScheduleService. El hot-path (feed de mapa + broadcast de pujas + oferta directa FIXED) lee
   * `getKRings()`/`getWindows()` MUY seguido sobre una fila que cambia en el orden de HORAS: el cache
   * absorbe ese path read-heavy. Ambos getters comparten este slot (`getSnapshot`). Reglas:
   *  - SOLO se cachean lecturas EXITOSAS (incluido "sin fila" → defaults, respuesta válida).
   *  - `replaceConfig` (PUT) INVALIDA el cache → el cambio surte efecto de inmediato, no tras el TTL.
   *  - Con TTL=0 el cache queda efectivamente deshabilitado (cada lectura expira de inmediato).
   */
  private cache: { snapshot: DispatchConfigSnapshot; expiresAt: number } | null = null;

  constructor(
    @Inject(DISPATCH_RADIUS_CONFIG_REPO) private readonly repo: DispatchRadiusConfigRepository,
    @Optional()
    @Inject(DISPATCH_RADIUS_CONFIG_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
    @Optional()
    @Inject(DISPATCH_WINDOW_DEFAULTS)
    // Fallback último (tests / sin DI): el DEFAULT_RADIUS_CONFIG. En runtime el módulo inyecta los
    // valores del env (DISPATCH_OFFER_TIMEOUT_MS / BID_WINDOW_SEC) → "env = seed del default de la DB".
    private readonly windowDefaults: DispatchWindows = {
      offerTimeoutMs: DEFAULT_RADIUS_CONFIG.offerTimeoutMs,
      bidWindowSec: DEFAULT_RADIUS_CONFIG.bidWindowSec,
    },
  ) {}

  /** GET interno: la config vigente (o el DEFAULT explícito si no hay fila), con metadatos de versión. */
  async getConfig(): Promise<PersistedRadiusConfig> {
    const persisted = await this.repo.find();
    if (persisted) return persisted;
    // Sin fila: DEFAULT explícito (version 0) para que el admin vea el estado real. Radios del
    // DEFAULT_RADIUS_CONFIG; ventanas del seed del env (windowDefaults).
    return {
      nearbyKRing: DEFAULT_RADIUS_CONFIG.nearbyKRing,
      matchKRing: DEFAULT_RADIUS_CONFIG.matchKRing,
      offerTimeoutMs: this.windowDefaults.offerTimeoutMs,
      bidWindowSec: this.windowDefaults.bidWindowSec,
      // Sin fila → política v1 (comportamiento actual) explícita: el admin ve el estado real.
      policyVersion: 'v1',
      policyV2: null,
      version: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  /**
   * Snapshot vigente (radios + ventanas) para el HOT-PATH, CACHEADO (1 slot). En miss/vencido lee del
   * repo y cachea solo si la lectura fue exitosa (un throw NO se cachea). Sin fila → radios del
   * DEFAULT_RADIUS_CONFIG + ventanas del seed del env (degradación honesta). El PUT invalida el cache.
   */
  private async getSnapshot(): Promise<DispatchConfigSnapshot> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.snapshot;

    const persisted = await this.repo.find();
    const snapshot: DispatchConfigSnapshot = persisted
      ? {
          nearbyKRing: persisted.nearbyKRing,
          matchKRing: persisted.matchKRing,
          offerTimeoutMs: persisted.offerTimeoutMs,
          bidWindowSec: persisted.bidWindowSec,
          policyVersion: persisted.policyVersion,
          policyV2: persisted.policyV2,
        }
      : {
          nearbyKRing: DEFAULT_RADIUS_CONFIG.nearbyKRing,
          matchKRing: DEFAULT_RADIUS_CONFIG.matchKRing,
          offerTimeoutMs: this.windowDefaults.offerTimeoutMs,
          bidWindowSec: this.windowDefaults.bidWindowSec,
          policyVersion: 'v1',
          policyV2: null,
        };

    if (this.cacheTtlMs > 0) {
      this.cache = { snapshot, expiresAt: now + this.cacheTtlMs };
    }
    return snapshot;
  }

  /** k-rings vigentes (feed de mapa + broadcast de pujas). Lee el snapshot cacheado. */
  async getKRings(): Promise<KRings> {
    const { nearbyKRing, matchKRing } = await this.getSnapshot();
    return { nearbyKRing, matchKRing };
  }

  /** Ventanas vigentes (oferta directa FIXED + board de PUJA). Lee el MISMO snapshot cacheado. */
  async getWindows(): Promise<DispatchWindows> {
    const { offerTimeoutMs, bidWindowSec } = await this.getSnapshot();
    return { offerTimeoutMs, bidWindowSec };
  }

  /**
   * Política de despacho vigente (feature-flag ADR dispatch-policy-v2). Lee el MISMO snapshot cacheado.
   * Contrato de degradación: `v2` es NO-NULL SOLO cuando policyVersion==='v2' Y el JSON parseó bien; en
   * cualquier otro caso (v1, JSON malformado, sin fila) → `{ policyVersion:'v1', v2:null }` y los
   * consumidores (matcher FIXED, broadcast PUJA, radar) usan el camino v1 VERBATIM. Un policyVersion='v2'
   * con policyV2 null (edición rota) se degrada a v1 en la práctica: v2 sale null → nadie ejecuta v2.
   */
  async getPolicy(): Promise<DispatchPolicy> {
    const { policyVersion, policyV2 } = await this.getSnapshot();
    if (policyVersion === 'v2' && policyV2) return { policyVersion: 'v2', v2: policyV2 };
    return { policyVersion: 'v1', v2: null };
  }

  /**
   * PUT interno: REEMPLAZA la config (radios + ventanas), bumpea `version` y persiste + EMITE
   * dispatch.radius_config_updated por outbox en la MISMA transacción (audit + consumidores futuros).
   * Invalida el cache → el cambio se ve en el siguiente getKRings/getWindows SIN esperar el TTL.
   * Idempotente en forma: re-enviar el mismo snapshot deja el mismo estado (solo sube la version).
   */
  async replaceConfig(
    input: KRings & DispatchWindows & { policyVersion: string; policyV2: DispatchPolicyV2 | null },
  ): Promise<PersistedRadiusConfig> {
    const current = await this.repo.find();
    const nextVersion = (current?.version ?? 0) + 1;

    const fields = {
      nearbyKRing: input.nearbyKRing,
      matchKRing: input.matchKRing,
      offerTimeoutMs: input.offerTimeoutMs,
      bidWindowSec: input.bidWindowSec,
      policyVersion: input.policyVersion,
    };
    // Columna Json? — para escribir SQL NULL Prisma exige el sentinel `DbNull` (pasar `null` es un error de
    // tipo en Prisma 5). El objeto validado se serializa como InputJsonValue.
    const policyV2Db =
      input.policyV2 === null
        ? Prisma.DbNull
        : (input.policyV2 as unknown as Prisma.InputJsonValue);

    const result = await this.repo.runInTx(async (tx) => {
      const row = await tx.dispatchRadiusConfig.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, ...fields, policyV2: policyV2Db, version: nextVersion },
        update: { ...fields, policyV2: policyV2Db, version: nextVersion },
      });
      // Outbox EN LA MISMA TX (FOUNDATION §6): audit + consumidores futuros del cambio de config. El payload
      // lleva el policyV2 como objeto plano (null real, no el sentinel DbNull) para que el evento sea legible.
      await tx.outboxEvent.create({
        data: {
          aggregateId: SINGLETON_ID,
          eventType: DISPATCH_RADIUS_CONFIG_UPDATED,
          envelope: createEnvelope({
            eventType: DISPATCH_RADIUS_CONFIG_UPDATED,
            producer: PRODUCER,
            payload: {
              ...fields,
              policyV2: input.policyV2,
              version: row.version,
              updatedAt: row.updatedAt.toISOString(),
            },
          }),
        },
      });
      return row;
    });

    // INVALIDA el cache: el PUT y el hot-path viven en el MISMO proceso, así que un cambio de config debe
    // verse en el siguiente getKRings/getWindows/getPolicy SIN esperar el TTL (sino tardaría hasta `cacheTtlMs`).
    this.cache = null;

    this.logger.log(
      `dispatch radius config REEMPLAZADO → version ${result.version} ` +
        `(nearbyKRing ${input.nearbyKRing}, matchKRing ${input.matchKRing}, ` +
        `offerTimeoutMs ${input.offerTimeoutMs}, bidWindowSec ${input.bidWindowSec}, ` +
        `policyVersion ${input.policyVersion}); ` +
        `${DISPATCH_RADIUS_CONFIG_UPDATED} emitido; cache invalidado`,
    );
    return {
      ...fields,
      policyV2: input.policyV2,
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
    };
  }
}
