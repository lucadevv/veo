/**
 * Watchdog de estado — SWEEPER temporal de viajes estancados.
 *
 * GAP que cierra: la máquina de estados DEFINE terminales de fallo (EXPIRED/FAILED) pero NADA los
 * conducía. Un viaje atascado en REQUESTED (sin conductor), ASSIGNED/ACCEPTED/ARRIVING/ARRIVED (el
 * conductor no aceptó o nunca recogió) o IN_PROGRESS (app del conductor caída) se quedaba ahí PARA
 * SIEMPRE (agujero negro). Este cron barre periódicamente y los lleva a su terminal:
 *   - Pre-recojo vencido → EXPIRED.
 *   - IN_PROGRESS vencido (holgura generosa) → FAILED (viaje abandonado).
 *
 * Espeja el patrón de `scheduled-trips.scheduler.ts` (mismo idiom @Cron, mismo wiring de módulo, la
 * transición + outbox van en la misma transacción vía TripsService). Cada barrido es IDEMPOTENTE
 * (guard de carrera por viaje en TripWatchdogService.sweepStalledTrip) y ACOTADO (lote por tick), por lo
 * que solapamientos de ticks o réplicas no producen doble transición ni doble evento.
 *
 * Model-agnóstico A PROPÓSITO: NO consume dispatch.timeout (esa ruta se rehará en el rediseño de
 * puja/bidding). Este sweeper temporal cubre los estancamientos REQUESTED como backstop suficiente.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Env } from '../config/env.schema';
import type { WatchdogThresholds } from './domain/watchdog';
import { TripWatchdogService } from './trip-watchdog.service';

/** Tope de viajes barridos por tick para acotar la carga (el resto cae en el siguiente tick). */
const MAX_PER_TICK = 200;

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;

@Injectable()
export class TripWatchdogScheduler {
  private readonly logger = new Logger(TripWatchdogScheduler.name);
  /** Evita solapamiento si un tick tarda más de su intervalo. */
  private running = false;
  private readonly thresholds: WatchdogThresholds;

  constructor(
    private readonly watchdog: TripWatchdogService,
    config: ConfigService<Env, true>,
  ) {
    this.thresholds = {
      requestedMs: config.get('TRIP_REQUESTED_TIMEOUT_MIN', { infer: true }) * MIN_MS,
      prePickupMs: config.get('TRIP_PREPICKUP_TIMEOUT_MIN', { infer: true }) * MIN_MS,
      inProgressMs: config.get('TRIP_INPROGRESS_STALE_HOURS', { infer: true }) * HOUR_MS,
    };
  }

  /** `now` inyectable solo para tests deterministas; en producción usa el reloj real. */
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Corte más permisivo = el umbral MÁS PEQUEÑO: un viaje es candidato en cuanto supera el menor
      // de los umbrales (p.ej. REQUESTED a 10 min, aunque IN_PROGRESS aguante 6 h). El dominio
      // (resolveStalledTarget) decide por viaje si realmente vence según su familia de estado.
      const smallest = Math.min(
        this.thresholds.requestedMs,
        this.thresholds.prePickupMs,
        this.thresholds.inProgressMs,
      );
      const staleBefore = new Date(now.getTime() - smallest);
      const candidates = await this.watchdog.findStalledCandidates(staleBefore, MAX_PER_TICK);
      if (candidates.length === 0) return;

      let expired = 0;
      let failed = 0;
      for (const c of candidates) {
        try {
          const target = await this.watchdog.sweepStalledTrip(c.id, this.thresholds, now);
          if (target === 'EXPIRED') expired++;
          else if (target === 'FAILED') failed++;
        } catch (err) {
          // Un fallo aislado no detiene el barrido; el viaje se reintenta al siguiente tick.
          this.logger.error(
            { err, tripId: c.id },
            'watchdog: no se pudo barrer el viaje estancado',
          );
        }
      }
      if (expired > 0 || failed > 0) {
        this.logger.log(`watchdog: ${expired} → EXPIRED, ${failed} → FAILED`);
      }
    } catch (err) {
      this.logger.error({ err }, 'watchdog: el barrido de viajes estancados falló');
    } finally {
      this.running = false;
    }
  }
}
