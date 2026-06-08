/**
 * ScheduledTripService — viajes PROGRAMADOS (reserva, Ola 2B). Extraído de TripsService (#6, SRP):
 * activación por el cron (SCHEDULED → REQUESTED respetando el modo congelado, ADR 011), cancelación
 * de la reserva antes de activarse (sin penalidad) y selección de los que ya vencen. La negociación
 * inmediata + las transiciones del viaje vivo siguen en TripsService.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundError, ConflictError, type LatLon } from '@veo/utils';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { TripStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { toTripView } from './trip-view.mapper';
import { PRODUCER, recordTripEvent } from './trip-events';
import { DispatchModeRegistry } from './dispatch-mode/dispatch-mode.registry';
import { assertTransition } from './domain/trip-state-machine';
import type { Trip } from '../generated/prisma';
import type { TripView } from './dto/trip.dto';
import type { Env } from '../config/env.schema';

@Injectable()
export class ScheduledTripService {
  private readonly logger = new Logger(ScheduledTripService.name);
  /** Registry de estrategias por modo (open/closed). Self-default sin DI para tests legacy. */
  private readonly dispatchModes: DispatchModeRegistry;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() config?: ConfigService<Env, true>,
    @Optional() dispatchModes?: DispatchModeRegistry,
  ) {
    this.dispatchModes = dispatchModes ?? new DispatchModeRegistry(config);
  }

  /**
   * Activación de UN viaje programado (la invoca el scheduler/cron). Transiciona SCHEDULED →
   * REQUESTED y emite trip.requested (dispatch arranca el matching como en un viaje normal).
   * Idempotente: si el viaje ya no está SCHEDULED (otro tick lo activó, o fue cancelado), no hace nada.
   */
  async activateScheduledTrip(id: string): Promise<void> {
    const trip = await this.prisma.read.trip.findUnique({ where: { id } });
    if (!trip) return;
    if (trip.status !== TripStatus.SCHEDULED) return; // ya activado/cancelado: idempotente
    assertTransition(trip.status, TripStatus.REQUESTED);

    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const destination: LatLon = { lat: trip.destLat, lon: trip.destLon };

    await this.prisma.write.$transaction(async (tx) => {
      // Guard de carrera: solo activa si SIGUE SCHEDULED (no two-tick double dispatch).
      const updated = await tx.trip.updateMany({
        where: { id, status: TripStatus.SCHEDULED },
        data: { status: TripStatus.REQUESTED, activatedAt: new Date(), requestedAt: new Date() },
      });
      if (updated.count === 0) return; // otro tick ganó la carrera
      const activated: Trip = { ...trip, status: TripStatus.REQUESTED };
      // ADR 011 §1.2/§4 · resolve-once: la activación respeta el modo CONGELADO del viaje (resuelto al
      // CREAR la reserva), NO re-resuelve de la config admin actual. La apertura por modo va por el
      // Strategy (open/closed): PUJA → trip.bid_posted (scheduled=true, el pasajero no está en la app →
      // push con deep-link al board); FIXED → trip.requested. Un modo sin strategy falla FUERTE (forMode
      // lanza), no cae silenciosamente en la rama PUJA (antes era un `if FIXED else PUJA` binario).
      await this.dispatchModes
        .forMode(trip.dispatchMode)
        .openDispatch(tx, activated, origin, destination, { scheduled: true });
    });
    this.logger.log(`Viaje programado ${id} activado → REQUESTED (modo ${trip.dispatchMode})`);
  }

  /**
   * DELETE /trips/:id/schedule — cancela un viaje PROGRAMADO antes de su activación (Ola 2B).
   * SIN penalidad: aún no hubo asignación ni conductor en camino (BR-T03 no aplica a una reserva).
   * Solo permitido en estado SCHEDULED; si ya se activó, debe usarse el flujo de cancelación normal.
   */
  async cancelScheduledTrip(id: string, passengerId: string): Promise<TripView> {
    const trip = await this.mustFind(id);
    if (trip.passengerId !== passengerId) {
      throw new NotFoundError('Viaje no encontrado', { id }); // no se filtra existencia ajena
    }
    if (trip.status !== TripStatus.SCHEDULED) {
      throw new ConflictError('El viaje ya no está programado; usa la cancelación normal', {
        status: trip.status,
      });
    }
    assertTransition(trip.status, TripStatus.CANCELLED_BY_PASSENGER);
    const now = new Date();
    const updated = await this.prisma.write.$transaction(async (tx) => {
      const next = await tx.trip.update({
        where: { id },
        data: {
          status: TripStatus.CANCELLED_BY_PASSENGER,
          cancelledAt: now,
          cancelledBy: 'PASSENGER',
          cancellationReason: 'scheduled_cancelled',
          penaltyCents: 0, // sin penalidad por cancelar una reserva con antelación
        },
      });
      await recordTripEvent(tx, id, 'trip.cancelled', { by: 'PASSENGER', penaltyCents: 0, scheduled: true });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.cancelled',
          producer: PRODUCER,
          payload: { tripId: id, by: 'PASSENGER', reason: 'scheduled_cancelled', penaltyCents: 0, passengerId: trip.passengerId },
        }),
        id,
      );
      return next;
    });
    return toTripView(updated);
  }

  /**
   * Selecciona los viajes programados que YA deben activarse (faltan ≤ lead time). La consulta se
   * delega aquí para que el scheduler quede fino. `dueBefore` = now + leadMs.
   */
  async findDueScheduled(dueBefore: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.read.trip.findMany({
      where: { status: TripStatus.SCHEDULED, scheduledFor: { lte: dueBefore } },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async mustFind(id: string): Promise<Trip> {
    const trip = await this.prisma.write.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundError('Viaje no encontrado', { id });
    return trip;
  }
}
