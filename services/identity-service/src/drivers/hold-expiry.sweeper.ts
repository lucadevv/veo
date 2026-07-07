/**
 * HoldExpirySweeper — barre los holds de suspensión TEMPORALES vencidos y reactiva al conductor (primer
 * mecanismo de expiración de holds del sistema · decisión del dueño · compliance/seguridad).
 *
 * Hoy el único hold temporal es EXCESSIVE_CANCELLATIONS (auto-suspensión por exceso de cancelaciones, con
 * `expiresAt = now + cooldown`). Cada intervalo configurable (`HOLD_SWEEP_INTERVAL_MINUTES`) este cron:
 *   1) lee TODOS los holds con `expiresAt < now` (UNA query, batch),
 *   2) agrupa por conductor en memoria,
 *   3) quita los vencidos y recomputa `Driver.suspendedAt` por conductor afectado,
 *   4) si el conductor quedó con 0 holds, emite `driver.reactivated` (outbox-in-tx).
 * Toda la lógica vive en `DriversService.sweepExpiredHolds` (acceso a holds + recompute + outbox); este cron
 * es solo el disparador temporal (espejo de DeletionSweeper).
 *
 * INTERVALO CONFIGURABLE: NestJS `@Interval`/`@Cron` no aceptan valores dinámicos en el decorator, así que el
 * intervalo se registra en `onModuleInit` vía `SchedulerRegistry` con el valor del env (minutos → ms).
 *
 * POR QUÉ SWEEPER y NO expiración LAZY: `suspendedAt` es la columna derivada ÚNICA que leen startShift/dispatch/
 * booking/admin; lazy la dejaría STALE. El sweeper mantiene la verdad derivada. Lag de minutos sobre un cooldown
 * de horas = despreciable.
 *
 * RESIDUAL CONOCIDO (no resuelto, mismo que el expiry-sweeper de fleet): @Cron/Interval SIN lock distribuido →
 * en multi-réplica corren N sweeps en paralelo. Es IDEMPOTENTE (deleteMany + recompute en DriversService), así
 * que NO corrompe estado: a lo sumo trabajo duplicado (una réplica gana el deleteMany, la otra cuenta 0).
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DriversService } from './drivers.service';
import type { Env } from '../config/env.schema';

const INTERVAL_NAME = 'hold-expiry-sweep';

@Injectable()
export class HoldExpirySweeper implements OnModuleInit {
  private readonly logger = new Logger(HoldExpirySweeper.name);
  private readonly intervalMs: number;
  /** Evita solapamiento si un barrido tarda más que el intervalo (un solo sweep en vuelo por réplica). */
  private running = false;

  constructor(
    private readonly drivers: DriversService,
    private readonly scheduler: SchedulerRegistry,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.getOrThrow<number>('HOLD_SWEEP_INTERVAL_MINUTES') * 60 * 1000;
  }

  onModuleInit(): void {
    const handle = setInterval(() => void this.run(), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, handle);
    this.logger.log(`Sweeper de holds temporales armado (cada ${this.intervalMs / 60_000} min)`);
  }

  /** Tick del cron: barre y loguea. Reentrante-safe (skip si ya hay un barrido en vuelo). */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const reactivated = await this.drivers.sweepExpiredHolds();
      if (reactivated > 0) {
        this.logger.log(
          `Holds temporales vencidos barridos: ${reactivated} conductor(es) reactivado(s)`,
        );
      }
    } catch (err) {
      // No relanzamos: un fallo de un tick NO debe matar el intervalo. El próximo tick reintenta (idempotente).
      this.logger.error({ err }, 'Falló el barrido de holds temporales vencidos');
    } finally {
      this.running = false;
    }
  }
}
