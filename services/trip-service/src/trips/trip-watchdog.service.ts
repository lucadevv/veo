/**
 * TripWatchdogService — sweeper temporal de viajes ESTANCADOS (backstop de la máquina de estados).
 * Extraído de TripsService (#6, SRP): el cron (TripWatchdogScheduler) decide CUÁNDO barrer; aquí vive
 * el CÓMO (selección de candidatos + transición idempotente a EXPIRED/FAILED con su outbox). La
 * decisión de dominio por viaje la toma resolveStalledTarget (domain/watchdog).
 */
import { Injectable, Logger } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { TripStatus } from '@veo/shared-types';
import { TripWatchdogRepository, type WatchdogSnapshot } from './trip-watchdog.repository';
import { PRODUCER, recordTripEvent } from './trip-events';
import { assertTransition } from './domain/trip-state-machine';
import {
  resolveStalledTarget,
  WATCHED_STATES,
  type WatchdogThresholds,
  type StalledTarget,
} from './domain/watchdog';

@Injectable()
export class TripWatchdogService {
  private readonly logger = new Logger(TripWatchdogService.name);

  constructor(private readonly repo: TripWatchdogRepository) {}

  /**
   * Selecciona viajes NO terminales cuya última actividad (`updatedAt`) es anterior al corte más
   * permisivo de los umbrales del watchdog. Es un PRE-FILTRO barato: el cron decide por viaje el
   * terminal concreto con `resolveStalledTarget` (umbral por familia de estado). Devolvemos snapshot
   * mínimo (id, status, passengerId, driverId, updatedAt) para no recargar el viaje completo.
   *
   * `staleBefore` debe ser el corte MÁS ANTIGUO posible (el mayor de los umbrales) para no perder
   * candidatos; el filtrado fino por estado lo hace el dominio.
   */
  async findStalledCandidates(staleBefore: Date, limit: number): Promise<WatchdogSnapshot[]> {
    return this.repo.findStalledCandidates(WATCHED_STATES, staleBefore, limit);
  }

  /**
   * Lleva UN viaje estancado a su terminal de fallo (EXPIRED pre-recojo / FAILED en curso) en UNA
   * transacción: status + trip_event + outbox (trip.expired | trip.failed) para que downstream
   * reaccione (notificar al pasajero; payment anula/omite cobro). La invoca el TripWatchdogScheduler.
   *
   * IDEMPOTENTE y seguro ante carreras: relee el viaje, recalcula el target con el reloj actual y usa
   * un updateMany con guard `where status = <estado observado>`. Si otro tick/endpoint ya lo movió
   * (count 0) no hace nada. Devuelve el terminal aplicado, o null si no se transicionó.
   */
  async sweepStalledTrip(
    id: string,
    thresholds: WatchdogThresholds,
    now: Date = new Date(),
  ): Promise<StalledTarget | null> {
    const trip = await this.repo.findWatchdogSnapshot(id);
    if (!trip) return null;
    const target = resolveStalledTarget(trip.status, trip.updatedAt, now, thresholds);
    if (target === null) return null; // ya no estancado / ya terminal / aún fresco
    assertTransition(trip.status, target); // la guarda ya permite estos → EXPIRED/FAILED

    const staleMinutes = Math.floor((now.getTime() - trip.updatedAt.getTime()) / 60000);
    const eventType = target === TripStatus.EXPIRED ? 'trip.expired' : 'trip.failed';

    const applied = await this.repo.runInTransaction(async (tx) => {
      // Guard de carrera: solo transiciona si SIGUE en el estado observado (no doble barrido ni
      // pisar una transición legítima — accept/cancel/complete — que ocurrió entre el read y aquí).
      const updated = await this.repo.casGuardedStatusUpdate(tx, id, trip.status, target);
      if (updated.count === 0) return false; // otro actor ganó la carrera

      const payload = {
        tripId: id,
        passengerId: trip.passengerId,
        fromStatus: trip.status,
        driverId: trip.driverId ?? undefined,
        staleMinutes,
        at: now.toISOString(),
      };
      await recordTripEvent(tx, id, eventType, payload);
      await enqueueOutbox(tx, createEnvelope({ eventType, producer: PRODUCER, payload }), id);
      return true;
    });

    if (!applied) return null;
    this.logger.log(
      `watchdog: viaje ${id} ${trip.status} → ${target} (estancado ${staleMinutes} min)`,
    );
    return target;
  }
}
