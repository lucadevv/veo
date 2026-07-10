/**
 * Puerto + adaptador Prisma del estado DURABLE del matching secuencial (FOUNDATION §10). Dueño del modelo
 * `DispatchSession`. El MatchingSessionStore es el SEAM de dominio (start/get/bumpKRing/closeMatched…): la
 * elección del terminal y el mapeo count→boolean del CAS quedan en el store; SOLO el acceso Prisma vive acá.
 */
import { Injectable } from '@nestjs/common';
import type { VehicleClass } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { DispatchSessionStatus, type DispatchSession } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const MATCHING_SESSION_REPO = Symbol('MATCHING_SESSION_REPO');

/** Campos de la sesión que el store compone al abrir/re-abrir una ronda (shape de dominio). */
export interface SessionSeed {
  originLat: number;
  originLon: number;
  vehicleType: VehicleClass;
  category: string | null;
  status: DispatchSessionStatus;
  currentKRing: number;
}

/** Puerto: el MatchingSessionStore depende de esto, NO de Prisma. */
export interface MatchingSessionRepository {
  /** Abre —o RE-abre (upsert)— la sesión del viaje; en el update refresca `createdAt` (inicio de ronda). */
  upsert(tripId: string, seed: SessionSeed): Promise<DispatchSession>;
  /** Lee la sesión del viaje (read). `null` si no existe. */
  find(tripId: string): Promise<DispatchSession | null>;
  /** Avanza el k-ring de búsqueda persistido. */
  updateKRing(tripId: string, kRing: number): Promise<void>;
  /** CAS: cierra la sesión al `status` SOLO si seguía OPEN. Devuelve cuántas filas cambió (0 o 1). */
  closeIfOpen(tripId: string, status: DispatchSessionStatus): Promise<number>;
}

@Injectable()
export class PrismaMatchingSessionRepository implements MatchingSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  upsert(tripId: string, seed: SessionSeed): Promise<DispatchSession> {
    return this.prisma.write.dispatchSession.upsert({
      where: { tripId },
      create: { tripId, ...seed },
      update: { ...seed, createdAt: new Date() },
    });
  }

  find(tripId: string): Promise<DispatchSession | null> {
    return this.prisma.read.dispatchSession.findUnique({ where: { tripId } });
  }

  async updateKRing(tripId: string, kRing: number): Promise<void> {
    await this.prisma.write.dispatchSession.update({
      where: { tripId },
      data: { currentKRing: kRing },
    });
  }

  async closeIfOpen(tripId: string, status: DispatchSessionStatus): Promise<number> {
    const res = await this.prisma.write.dispatchSession.updateMany({
      where: { tripId, status: DispatchSessionStatus.OPEN },
      data: { status },
    });
    return res.count;
  }
}
