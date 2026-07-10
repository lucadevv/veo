/**
 * MatchingSessionStore — estado DURABLE del matching secuencial (FIXED) de un viaje (D2.1). Repositorio
 * fino sobre `DispatchSession`: lo que reemplaza al `pending` Map en proceso. El "advance" (offerNext) lo
 * lee desde cualquier réplica para ofertar al siguiente candidato sin el evento original.
 *
 * Los cierres (MATCHED/TIMED_OUT/CANCELLED) son CAS atómicos (`updateMany` con guard `status=OPEN`):
 * solo UNA transición gana → idempotentes y concurrencia-seguros (dos réplicas no cierran dos veces).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { LatLon } from '@veo/utils';
import type { VehicleClass } from '@veo/shared-types';
import { DispatchSessionStatus, type DispatchSession } from '../generated/prisma';
import {
  MATCHING_SESSION_REPO,
  type MatchingSessionRepository,
} from './matching-session.repository';

@Injectable()
export class MatchingSessionStore {
  constructor(
    @Inject(MATCHING_SESSION_REPO) private readonly repo: MatchingSessionRepository,
  ) {}

  /**
   * Abre —o RE-abre, en un re-bid (EXPIRED→REQUESTED)— la sesión OPEN del viaje. `createdAt` marca el
   * inicio de ESTA ronda: el advance solo cuenta como "ya ofertados" los matches con offeredAt ≥ createdAt,
   * así un re-bid vuelve a ofertar a conductores de rondas previas (paridad con el matcher viejo).
   */
  start(input: {
    tripId: string;
    origin: LatLon;
    vehicleType: VehicleClass;
    category?: string;
  }): Promise<DispatchSession> {
    return this.repo.upsert(input.tripId, {
      originLat: input.origin.lat,
      originLon: input.origin.lon,
      vehicleType: input.vehicleType,
      // B5-3 · oferta del viaje, para que el advance resuelva sus requisitos de eligibilidad.
      category: input.category ?? null,
      status: DispatchSessionStatus.OPEN,
      currentKRing: 1,
    });
  }

  get(tripId: string): Promise<DispatchSession | null> {
    return this.repo.find(tripId);
  }

  /** Avanza el k-ring de búsqueda persistido (el advance expande al agotar los candidatos cercanos). */
  async bumpKRing(tripId: string, kRing: number): Promise<void> {
    await this.repo.updateKRing(tripId, kRing);
  }

  /** Cierra la sesión a un terminal SOLO si seguía OPEN (CAS). Devuelve true si ESTA llamada la cerró. */
  private async close(tripId: string, status: DispatchSessionStatus): Promise<boolean> {
    return (await this.repo.closeIfOpen(tripId, status)) === 1;
  }

  closeMatched(tripId: string): Promise<boolean> {
    return this.close(tripId, DispatchSessionStatus.MATCHED);
  }
  closeTimedOut(tripId: string): Promise<boolean> {
    return this.close(tripId, DispatchSessionStatus.TIMED_OUT);
  }
  closeCancelled(tripId: string): Promise<boolean> {
    return this.close(tripId, DispatchSessionStatus.CANCELLED);
  }
}
