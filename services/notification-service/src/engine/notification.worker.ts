/**
 * NotificationWorker — drena periódicamente la cola de notificaciones vencidas (PENDING con
 * nextAttemptAt <= now) y dispara el intento de entrega. Intervalo configurable vía
 * ScheduleModule (SchedulerRegistry). No solapa ejecuciones (lock en memoria).
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { NotificationEngine } from './notification.engine';
import type { Env } from '../config/env.schema';

const INTERVAL_NAME = 'notification-worker';

@Injectable()
export class NotificationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorker.name);
  private readonly intervalMs: number;
  private readonly batch: number;
  private running = false;

  constructor(
    private readonly engine: NotificationEngine,
    private readonly scheduler: SchedulerRegistry,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.getOrThrow<number>('NOTIFICATION_WORKER_INTERVAL_MS');
    this.batch = config.getOrThrow<number>('NOTIFICATION_WORKER_BATCH');
  }

  onModuleInit(): void {
    const timer = setInterval(() => void this.tick(), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, timer);
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.engine.drainDue(this.batch);
      if (n > 0) this.logger.debug(`worker procesó ${n} notificación(es)`);
    } catch (err) {
      this.logger.error({ err }, 'worker de notificaciones falló');
    } finally {
      this.running = false;
    }
  }
}
