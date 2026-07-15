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
import { ScheduledTripRepository } from './scheduled-trip.repository';
import { CatalogService } from '../catalog/catalog.service';
import { toTripView } from './trip-view.mapper';
import { PRODUCER, recordTripEvent } from './trip-events';
import { DispatchModeRegistry } from './dispatch-mode/dispatch-mode.registry';
import { assertTransition } from './domain/trip-state-machine';
import { resolveTripOffering } from './domain/offering';
import { bumpCatalogDegraded } from './trip-metrics';
import type { Trip } from '../generated/prisma';
import type { TripView } from './dto/trip.dto';
import type { Env } from '../config/env.schema';

@Injectable()
export class ScheduledTripService {
  private readonly logger = new Logger(ScheduledTripService.name);
  /** Registry de estrategias por modo (open/closed). Self-default sin DI para tests legacy. */
  private readonly dispatchModes: DispatchModeRegistry;

  /** Catálogo de ofertas (overlay admin, ADR 013 · Fase B). @Optional: tests legacy degradan honesto. */
  private readonly catalog?: CatalogService;

  constructor(
    private readonly repo: ScheduledTripRepository,
    @Optional() config?: ConfigService<Env, true>,
    @Optional() dispatchModes?: DispatchModeRegistry,
    @Optional() catalog?: CatalogService,
  ) {
    this.dispatchModes = dispatchModes ?? new DispatchModeRegistry(config);
    this.catalog = catalog;
  }

  /**
   * Activación de UN viaje programado (la invoca el scheduler/cron). Transiciona SCHEDULED →
   * REQUESTED y emite trip.requested (dispatch arranca el matching como en un viaje normal).
   * Idempotente: si el viaje ya no está SCHEDULED (otro tick lo activó, o fue cancelado), no hace nada.
   */
  async activateScheduledTrip(id: string): Promise<void> {
    const trip = await this.repo.findByIdRead(id);
    if (!trip) return;
    if (trip.status !== TripStatus.SCHEDULED) return; // ya activado/cancelado: idempotente

    // ADR 013 · Fase B — si la oferta del viaje ya NO se puede concretar entre la reserva y la
    // activación, el viaje se EXPIRA (terminal, sin cobro) y se notifica al pasajero. Dos causas, mismo
    // desenlace: (a) DESHABILITADA por el admin en el overlay; (b) REMOVIDA del catálogo de código
    // (release coordinado, Fase C) ⇒ resolveTripOffering lanza. Convención del repo
    // (push-notification.registry): una terminación de SISTEMA usa trip.expired, NO trip.cancelled
    // (by=SYSTEM → se cubre con expired/failed). La oferta se resuelve igual que en createTrip, no por
    // el `category` crudo. Capturar el throw evita un poison-trip (el scheduler reintenta cada tick).
    let offeringId: string;
    try {
      offeringId = resolveTripOffering(trip.category, trip.vehicleType).offering.id;
    } catch (err) {
      this.logger.warn(
        `oferta del programado ${id} ya no existe en el catálogo de código ` +
          `(${(err as Error).message}); se expira el viaje`,
      );
      await this.expireForDisabledOffering(trip, trip.category ?? 'unknown');
      return;
    }
    if (!(await this.isOfferingEnabled(offeringId))) {
      await this.expireForDisabledOffering(trip, offeringId);
      return;
    }

    assertTransition(trip.status, TripStatus.REQUESTED);

    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const destination: LatLon = { lat: trip.destLat, lon: trip.destLon };

    await this.repo.runInTransaction(async (tx) => {
      // Guard de carrera: solo activa si SIGUE SCHEDULED (no two-tick double dispatch).
      const updated = await this.repo.casGuardedScheduledUpdate(tx, id, {
        status: TripStatus.REQUESTED,
        activatedAt: new Date(),
        requestedAt: new Date(),
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
   * ¿La oferta sigue habilitada en el overlay admin? Degradación honesta: si el catálogo no está
   * inyectado (tests legacy) o falla la lectura, devuelve `true` — NO abortamos un viaje YA reservado
   * por una lectura de config caída (mismo criterio que el quote/create en TripsService).
   */
  private async isOfferingEnabled(offeringId: string): Promise<boolean> {
    if (!this.catalog) return true;
    try {
      return await this.catalog.isEnabled(offeringId);
    } catch (err) {
      this.logger.warn(
        `catálogo no disponible al activar oferta '${offeringId}' (${(err as Error).message}); ` +
          `se permite la activación (degradación honesta)`,
      );
      bumpCatalogDegraded('activate');
      return true;
    }
  }

  /**
   * EXPIRA un programado cuya oferta fue deshabilitada: SCHEDULED → EXPIRED (terminal, sin cobro) +
   * trip.expired para que notification-service avise al pasajero. Mismo shape de payload que
   * `TripsService.expireFromNoOffers` (un solo contrato de "viaje expirado"). Guard de carrera: solo
   * expira si SIGUE SCHEDULED (otro tick pudo activarlo/cancelarlo).
   */
  private async expireForDisabledOffering(trip: Trip, offeringId: string): Promise<void> {
    assertTransition(trip.status, TripStatus.EXPIRED);
    const at = new Date();
    await this.repo.runInTransaction(async (tx) => {
      const result = await this.repo.casGuardedScheduledUpdate(tx, trip.id, {
        status: TripStatus.EXPIRED,
      });
      if (result.count === 0) return; // otro tick ganó la carrera → no-op
      const payload = {
        tripId: trip.id,
        passengerId: trip.passengerId,
        fromStatus: trip.status,
        driverId: trip.driverId ?? undefined,
        staleMinutes: 0,
        at: at.toISOString(),
      };
      await recordTripEvent(tx, trip.id, 'trip.expired', {
        ...payload,
        reason: 'offering_disabled',
        offeringId,
        scheduled: true,
      });
      await enqueueOutbox(
        tx,
        createEnvelope({ eventType: 'trip.expired', producer: PRODUCER, payload }),
        trip.id,
      );
    });
    this.logger.warn(
      `Viaje programado ${trip.id} EXPIRADO: oferta '${offeringId}' deshabilitada por el admin`,
    );
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
    const updated = await this.repo.runInTransaction(async (tx) => {
      const next = await this.repo.updateByIdTx(tx, id, {
        status: TripStatus.CANCELLED_BY_PASSENGER,
        cancelledAt: now,
        cancelledBy: 'PASSENGER',
        cancellationReason: 'scheduled_cancelled',
        penaltyCents: 0, // sin penalidad por cancelar una reserva con antelación
      });
      await recordTripEvent(tx, id, 'trip.cancelled', {
        by: 'PASSENGER',
        penaltyCents: 0,
        scheduled: true,
      });
      await enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'trip.cancelled',
          producer: PRODUCER,
          payload: {
            tripId: id,
            by: 'PASSENGER',
            reason: 'scheduled_cancelled',
            penaltyCents: 0,
            passengerId: trip.passengerId,
          },
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
    return this.repo.findDueScheduledIds(dueBefore, limit);
  }

  private async mustFind(id: string): Promise<Trip> {
    const trip = await this.repo.findByIdOnPrimary(id);
    if (!trip) throw new NotFoundError('Viaje no encontrado', { id });
    return trip;
  }
}
