/**
 * Ola 2B — SCHEDULER de viajes programados.
 *
 * Cron (@nestjs/schedule) que, cada minuto, busca viajes en estado SCHEDULED cuya hora (scheduledFor)
 * esté dentro del lead time de activación (default 10 min) y los activa: SCHEDULED → REQUESTED +
 * emisión de trip.requested (dispatch arranca el matching normal). Cada activación es IDEMPOTENTE
 * (guard de carrera en ScheduledTripService.activateScheduledTrip: solo activa si SIGUE SCHEDULED), por lo
 * que solapamientos de ticks o varias réplicas no producen doble dispatch.
 *
 * No es un consumidor Kafka ni un relay nuevo: el outbox.relay existente publica el trip.requested
 * que aquí se encola en la misma transacción que la transición de estado (FOUNDATION §6).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ACTIVATION_LEAD_MS } from './domain/scheduling';
import { ScheduledTripService } from './scheduled-trip.service';

/** Tope de viajes activados por tick para acotar la carga (los demás caen en el siguiente tick). */
const MAX_PER_TICK = 200;

@Injectable()
export class ScheduledTripsScheduler {
  private readonly logger = new Logger(ScheduledTripsScheduler.name);
  /** Evita solapamiento si un tick tarda más de un minuto. */
  private running = false;

  constructor(private readonly scheduled: ScheduledTripService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const dueBefore = new Date(Date.now() + ACTIVATION_LEAD_MS);
      const ids = await this.scheduled.findDueScheduled(dueBefore, MAX_PER_TICK);
      if (ids.length === 0) return;
      this.logger.log(`activando ${ids.length} viaje(s) programado(s)`);
      for (const id of ids) {
        try {
          await this.scheduled.activateScheduledTrip(id);
        } catch (err) {
          // Un fallo aislado no detiene el barrido; el viaje sigue SCHEDULED y se reintenta al siguiente tick.
          this.logger.error({ err, tripId: id }, 'no se pudo activar el viaje programado');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'el barrido de viajes programados falló');
    } finally {
      this.running = false;
    }
  }
}
