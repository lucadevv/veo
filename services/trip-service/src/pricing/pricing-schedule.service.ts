/**
 * PricingScheduleService (ADR 011) — carga el schedule del repo y delega en el ModeResolver PURO.
 *
 * Responsabilidades:
 *  - `resolve(zone, now)`: lee el snapshot (o DEFAULT_SCHEDULE si no hay fila) y devuelve PUJA|FIXED.
 *    Es lo que createTrip consume para CONGELAR el modo del viaje (resolve-once-persist-forever §1.2).
 *  - `getSchedule()`: el GET interno (admin/internal).
 *  - `replaceSchedule(...)`: el PUT interno — REEMPLAZA wholesale, bumpea version, persiste y EMITE
 *    pricing.mode_schedule_updated por outbox en la MISMA transacción (audit + consumidores futuros;
 *    NO es load-bearing: el resolver lee la tabla local, §3 ADR 011).
 *
 * La decisión de modo es PURA (domain/pricing-mode.ts); este servicio solo orquesta IO. El repo entra
 * por puerto (PRICING_SCHEDULE_REPO) — clean arch: el resolver no conoce Prisma.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { PricingMode } from '@veo/shared-types';
import {
  DEFAULT_SCHEDULE,
  resolveMode,
  type PricingModeRule,
  type PricingModeSchedule,
  type ZoneKey,
} from '../trips/domain/pricing-mode';
import {
  PRICING_SCHEDULE_REPO,
  SINGLETON_ID,
  type PersistedSchedule,
  type PricingScheduleRepository,
} from './pricing-schedule.repository';

const PRODUCER = 'trip-service';

/** Token DI del TTL (ms) del cache del schedule; lo provee el módulo desde PRICING_SCHEDULE_CACHE_TTL_MS. */
export const PRICING_SCHEDULE_CACHE_TTL_MS = Symbol('PRICING_SCHEDULE_CACHE_TTL_MS');

@Injectable()
export class PricingScheduleService {
  private readonly logger = new Logger(PricingScheduleService.name);

  /**
   * S3 (ADR 011 · espejo del cache de elegibilidad A4/H10) — cache in-proc de UN solo slot del schedule.
   * `loadSchedule()` hacía `repo.find()` (un read a la réplica) en CADA `resolve()` → 1 read DB por
   * createTrip + 1 por quote, sobre una fila que cambia en el orden de HORAS. El cache absorbe ese path
   * read-heavy. Es un SINGLETON (Tier 1 GLOBAL): un solo slot basta, sin Map. Reglas:
   *  - SOLO se cachean lecturas EXITOSAS (incluido "sin fila" → DEFAULT_SCHEDULE, una respuesta válida).
   *  - `replaceSchedule` (PUT) INVALIDA el cache → el cambio surte efecto de inmediato, no tras el TTL
   *    (mismo proceso sirve resolve + PUT). Sin esto, un flip de schedule tardaría hasta `cacheTtlMs`.
   *  - `find()` ya lee de la réplica (staleness acotado ya aceptado) → un TTL corto es consistente.
   * Con TTL=0 el cache queda efectivamente deshabilitado (cada lectura expira de inmediato).
   */
  private cache: { schedule: PricingModeSchedule; expiresAt: number } | null = null;

  constructor(
    @Inject(PRICING_SCHEDULE_REPO) private readonly repo: PricingScheduleRepository,
    @Optional()
    @Inject(PRICING_SCHEDULE_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
  ) {}

  /**
   * Resuelve el modo AUTORITATIVO para (zona, instante). Sin fila cargada → DEFAULT_SCHEDULE (PUJA, §8.2,
   * degradación honesta). La decisión la toma el resolver puro; acá solo cargamos el snapshot (cacheado).
   */
  async resolve(zone: ZoneKey, at: Date): Promise<PricingMode> {
    const schedule = await this.loadSchedule();
    return resolveMode(schedule, zone, at);
  }

  /** GET interno: el schedule vigente (o el default si no hay fila), con metadatos de versión. */
  async getSchedule(): Promise<PersistedSchedule> {
    const persisted = await this.repo.find();
    if (persisted) return persisted;
    // Sin fila: devolvemos el DEFAULT explícito (version 0) para que el admin vea el estado real.
    return { ...DEFAULT_SCHEDULE, version: 0, updatedAt: new Date(0).toISOString() };
  }

  /**
   * PUT interno: REEMPLAZA wholesale el schedule (sobrescribe defaultMode + rules enteros), bumpea
   * `version` y persiste + EMITE pricing.mode_schedule_updated por outbox en la MISMA transacción.
   * Idempotente en forma: re-enviar el mismo snapshot deja el mismo estado (solo sube la version).
   */
  async replaceSchedule(input: {
    defaultMode: PricingMode;
    rules: PricingModeRule[];
  }): Promise<PersistedSchedule> {
    const current = await this.repo.find();
    const nextVersion = (current?.version ?? 0) + 1;
    const updatedAtIso = new Date().toISOString();
    // Serializamos las reglas tal cual (ya validadas por el DTO) como JSON de la fila.
    const rulesJson = input.rules.map((r) => ({
      dayMask: r.dayMask,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      mode: r.mode,
    }));

    const result = await this.repo.runInTx(async (tx) => {
      const row = await tx.pricingModeSchedule.upsert({
        where: { id: SINGLETON_ID },
        create: {
          id: SINGLETON_ID,
          defaultMode: input.defaultMode,
          rules: rulesJson,
          version: nextVersion,
        },
        update: {
          defaultMode: input.defaultMode,
          rules: rulesJson,
          version: nextVersion,
        },
      });
      // Outbox EN LA MISMA TX (FOUNDATION §6): audit + consumidores futuros del cambio de schedule.
      await tx.outboxEvent.create({
        data: {
          aggregateId: SINGLETON_ID,
          eventType: 'pricing.mode_schedule_updated',
          envelope: createEnvelope({
            eventType: 'pricing.mode_schedule_updated',
            producer: PRODUCER,
            payload: {
              defaultMode: input.defaultMode,
              rules: rulesJson,
              version: row.version,
              updatedAt: row.updatedAt.toISOString(),
            },
          }),
        },
      });
      return row;
    });

    // S3 — INVALIDA el cache: el PUT y el resolve viven en el MISMO proceso, así que un cambio de schedule
    // debe verse en el siguiente resolve SIN esperar el TTL (sino un flip tardaría hasta `cacheTtlMs`).
    this.cache = null;

    this.logger.log(
      `pricing schedule REEMPLAZADO → version ${result.version} (defaultMode ${input.defaultMode}, ` +
        `${input.rules.length} regla(s)); pricing.mode_schedule_updated emitido; cache invalidado`,
    );
    return {
      defaultMode: input.defaultMode,
      rules: input.rules,
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  /**
   * Carga el snapshot del repo o el DEFAULT (PUJA) si no hay fila (degradación honesta §8.2).
   *
   * S3 — sirve del cache de UN slot si no venció; en miss/vencido lee del repo y CACHEA solo si la lectura
   * fue exitosa (un throw del repo NO se cachea: propaga como hasta ahora). El PUT invalida el cache.
   */
  private async loadSchedule(): Promise<PricingModeSchedule> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.schedule;

    const persisted = await this.repo.find();
    const schedule: PricingModeSchedule = persisted
      ? { defaultMode: persisted.defaultMode, rules: persisted.rules }
      : DEFAULT_SCHEDULE;

    if (this.cacheTtlMs > 0) {
      this.cache = { schedule, expiresAt: now + this.cacheTtlMs };
    }
    return schedule;
  }
}
