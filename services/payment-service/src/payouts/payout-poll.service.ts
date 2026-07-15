/**
 * PayoutPollService — POLL FALLBACK de la confirmación del DESEMBOLSO (money-OUT · ADR-015 §4.2).
 * ESPEJO EXACTO de `PaymentPollService` (money-IN): el desembolso es ASÍNCRONO (PROCESSING → confirma por
 * webhook/poll), y cuando el webhook del riel NO llega (dev sin túnel, o el riel push sin callback), este
 * barrido suave consulta el estado real del desembolso al riel (PULL, `PayoutStatusQuery`) y lo aplica por
 * el MISMO camino idempotente que aplicaría el webhook (`PayoutsService.applyPayoutDisbursementResult`).
 *
 * SUAVE por diseño (no martillar al riel), espejo del poll del CHARGE:
 *  - Solo corre si el gateway de payout soporta consulta de estado (type-guard ISP `supportsPayoutStatusQuery`)
 *    Y el poll está activado por env. El sandbox la soporta → cierra el ciclo e2e en dev sin PSP real.
 *  - Solo payouts PROCESSING con `externalRef`, actualizados en la última hora (ventana configurable).
 *  - Tope de N por tick. Lock Redis por tick (no se solapa entre instancias / ticks lentos).
 *  - Intervalo configurable (~25s). Registro dinámico de intervalo (lee la config validada).
 *
 * Una confirmación por poll y una redelivery posterior del webhook NO duplican nada: applyPayoutDisbursement-
 * Result es idempotente por status-guard (la 2ª ve el payout ya PROCESSED/FAILED y no re-emite ni re-marca).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { withDistributedLock } from '@veo/utils';
import { PayoutPollRepository } from './payout-poll.repository';
import { REDIS } from '../infra/redis';
import {
  PAYOUT_GATEWAY,
  supportsPayoutStatusQuery,
  type PayoutGateway,
} from '../ports/gateway/payout-gateway.port';
import { PayoutsService } from './payouts.service';
import type { Env } from '../config/env.schema';

const POLL_LOCK_KEY = 'veo:payment:lock:payout-disbursement-poll';
/** TTL del lock por tick: corto (un barrido acotado por batch no debería pasarse de esto). */
const POLL_LOCK_TTL_SECONDS = 30;
const POLL_INTERVAL_NAME = 'payout-disbursement-poll';

@Injectable()
export class PayoutPollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayoutPollService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly maxAgeMin: number;
  private readonly batch: number;
  /** Evita reentrada dentro de la MISMA instancia si un tick tarda más que el intervalo. */
  private running = false;

  constructor(
    private readonly repo: PayoutPollRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PAYOUT_GATEWAY) private readonly gateway: PayoutGateway,
    private readonly payouts: PayoutsService,
    private readonly scheduler: SchedulerRegistry,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.getOrThrow<boolean>('PAYOUT_POLL_ENABLED');
    this.intervalMs = config.getOrThrow<number>('PAYOUT_POLL_INTERVAL_MS');
    this.maxAgeMin = config.getOrThrow<number>('PAYOUT_POLL_MAX_AGE_MIN');
    this.batch = config.getOrThrow<number>('PAYOUT_POLL_BATCH');
  }

  /**
   * Registra el intervalo SOLO si el poll está activo (gateway con consulta de estado + env). Registro
   * dinámico (no decorador) para leer el intervalo de la config VALIDADA y no encender el barrido cuando el
   * adapter no soporta consulta (p.ej. el live antes del convenio).
   */
  onModuleInit(): void {
    if (!this.active) {
      this.logger.log(
        `Poll fallback de desembolso INACTIVO (enabled=${this.enabled}, statusQuery=${supportsPayoutStatusQuery(this.gateway)})`,
      );
      return;
    }
    const handle = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.scheduler.addInterval(POLL_INTERVAL_NAME, handle);
    this.logger.log(
      `Poll fallback de desembolso ACTIVO: cada ${this.intervalMs}ms, ventana ${this.maxAgeMin}min, batch ${this.batch}`,
    );
  }

  onModuleDestroy(): void {
    this.running = false;
    if (this.scheduler.doesExist('interval', POLL_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(POLL_INTERVAL_NAME);
    }
  }

  /** ¿El poll debe correr? Solo si el adapter consulta estado de desembolso + activado por env. */
  private get active(): boolean {
    return this.enabled && supportsPayoutStatusQuery(this.gateway);
  }

  async tick(): Promise<void> {
    if (!this.active || this.running) return;

    // Lock por tick (no se solapa entre instancias). NX+EX: si otro lo tomó, salimos en silencio.
    await withDistributedLock(
      this.redis,
      POLL_LOCK_KEY,
      POLL_LOCK_TTL_SECONDS,
      async () => {
        this.running = true;
        try {
          await this.pollOnce();
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'error';
          this.logger.warn(
            `Poll fallback de desembolso: tick con error (continúa el próximo): ${msg}`,
          );
        } finally {
          this.running = false;
        }
      },
      { releaseOnSettle: true },
    );
  }

  /**
   * Un barrido: toma hasta `batch` payouts PROCESSING RECLAMADOS (con `dedupKey`, el claim marker SIEMPRE
   * presente) de la última hora, consulta el estado al riel y aplica el desenlace por el camino idempotente
   * de la confirmación. Devuelve el conteo (para tests/observabilidad).
   *
   * RECONCILIACIÓN POR dedupKey, NO solo por externalRef (fix orfandad §4.2): antes filtraba `externalRef NOT
   * null` y un PROCESSING que perdió su externalRef (crash entre el disburse-OK y el persist del ref) quedaba
   * HUÉRFANO — invisible al poll, sin cierre. Ahora el ancla es el `dedupKey` (persistido en el claim a
   * PROCESSING, ANTES del riel: NUNCA falta). Pasamos `{ dedupKey, externalRef }` al riel; resuelve por el ref
   * si lo tiene, si no por la dedupKey. Un PROCESSING sin externalRef SÍ se reconcilia.
   */
  async pollOnce(): Promise<{ scanned: number; applied: number }> {
    if (!supportsPayoutStatusQuery(this.gateway)) return { scanned: 0, applied: 0 };

    // `since` = umbral de GRACIA de submit (maxAgeMin). Ya NO filtra el barrido (antes `updatedAt >= since`
    // dejaba HUÉRFANO todo PROCESSING más viejo que la ventana — sin red · fix #7). Ahora escaneamos TODO
    // PROCESSING (oldest-first, capado a `batch`: los viejos se trabajan primero, tick a tick) y usamos `since`
    // solo para decidir la recuperación por CRASH de abajo (#8).
    const since = new Date(Date.now() - this.maxAgeMin * 60_000);
    // Ancla de reconciliación: el claim marker `dedupKey`, NO el `externalRef` (que puede faltar por orfandad).
    // Todo PROCESSING legítimo fue reclamado con su dedupKey en la misma tx del claim. (WHERE cristalizado en el repo.)
    const processing = await this.repo.findProcessingPayoutsForPoll(this.batch);
    if (processing.length === 0) return { scanned: 0, applied: 0 };

    let applied = 0;
    for (const p of processing) {
      if (!this.running) break; // corte limpio si el módulo se destruye a mitad del barrido
      const dedupKey = p.dedupKey;
      if (!dedupKey) continue; // imposible por el filtro, pero el tipo es nullable: guard explícito
      try {
        const detail = await this.gateway.getDisbursementStatus({
          dedupKey,
          externalRef: p.externalRef,
        });
        if (detail.found && detail.status === 'PENDING') continue; // el riel lo tiene: sigue en curso
        if (!detail.found) {
          // El riel NO tiene registro del desembolso. RECIENTE (updatedAt >= since) → puede ser lag de registro,
          // seguimos esperando. VIEJO (< since, > maxAgeMin) → el disburse NUNCA llegó al riel: crash entre el
          // claim a PROCESSING (con dedupKey) y `gateway.disburse` (#8) → la plata NO se movió → reset
          // PROCESSING→FAILED para re-desembolsar (retryPayout · dedupKey-safe: si por lag el riel SÍ lo tenía,
          // la re-disburse con el MISMO dedupKey no duplica). Sin esto quedaba PROCESSING para siempre.
          if (p.updatedAt < since) {
            const res = await this.payouts.applyPayoutDisbursementResult({
              payoutId: p.id,
              resolution: 'REJECTED',
            });
            if (res.applied) {
              applied += 1;
              this.logger.warn(
                `Poll desembolso: payout=${p.id} PROCESSING sin registro en el riel tras ${this.maxAgeMin}min (crash pre-disburse) → FAILED para reintento`,
              );
            }
          }
          continue;
        }
        const res = await this.payouts.applyPayoutDisbursementResult({
          payoutId: p.id,
          resolution: detail.status,
        });
        if (res.applied) {
          applied += 1;
          this.logger.log(`Poll desembolso: payout=${p.id} resuelto por consulta (${res.status})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'error';
        this.logger.warn(`Poll desembolso: consulta falló payout=${p.id}: ${msg}`);
      }
    }
    if (applied > 0)
      this.logger.log(
        `Poll fallback de desembolso: ${applied}/${processing.length} payouts confirmados`,
      );
    return { scanned: processing.length, applied };
  }
}
