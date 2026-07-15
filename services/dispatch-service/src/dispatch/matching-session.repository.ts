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
  /**
   * v2 · Persiste el ring del matcher FIXED v2 + el próximo instante de expansión TEMPORAL (nextExpandAt).
   * Un solo write por oferta: fija dónde quedó la búsqueda y cuándo el sweep puede volver a ensanchar.
   */
  updateExpansion(tripId: string, kRing: number, nextExpandAt: Date | null): Promise<void>;
  /**
   * v2 · Sesiones OPEN cuya expansión TEMPORAL venció (`nextExpandAt ≤ now`) y aún NO llegaron a `maxK`.
   * Las más urgentes primero (nextExpandAt asc), tope `limit` (presupuesto del sweep).
   */
  findExpandable(
    now: Date,
    maxK: number,
    limit: number,
  ): Promise<Pick<DispatchSession, 'tripId' | 'currentKRing'>[]>;
  /**
   * v2 · CAS de expansión temporal: sube `currentKRing` de `fromK`→`toK` y re-arma `nextExpandAt` SOLO si
   * la sesión sigue OPEN y su ring es EXACTAMENTE `fromK` (guard anti-doble-avance entre réplicas/ticks).
   * Devuelve cuántas filas cambió (0 = otra réplica ya la avanzó, o el ring cambió).
   */
  advanceExpansion(
    tripId: string,
    fromK: number,
    toK: number,
    nextExpandAt: Date | null,
  ): Promise<number>;
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

  async updateExpansion(tripId: string, kRing: number, nextExpandAt: Date | null): Promise<void> {
    await this.prisma.write.dispatchSession.update({
      where: { tripId },
      data: { currentKRing: kRing, nextExpandAt },
    });
  }

  findExpandable(
    now: Date,
    maxK: number,
    limit: number,
  ): Promise<Pick<DispatchSession, 'tripId' | 'currentKRing'>[]> {
    return this.prisma.read.dispatchSession.findMany({
      where: {
        status: DispatchSessionStatus.OPEN,
        nextExpandAt: { not: null, lte: now },
        currentKRing: { lt: maxK },
      },
      select: { tripId: true, currentKRing: true },
      orderBy: { nextExpandAt: 'asc' },
      take: limit,
    });
  }

  async advanceExpansion(
    tripId: string,
    fromK: number,
    toK: number,
    nextExpandAt: Date | null,
  ): Promise<number> {
    const res = await this.prisma.write.dispatchSession.updateMany({
      where: { tripId, status: DispatchSessionStatus.OPEN, currentKRing: fromK },
      data: { currentKRing: toK, nextExpandAt },
    });
    return res.count;
  }

  async closeIfOpen(tripId: string, status: DispatchSessionStatus): Promise<number> {
    const res = await this.prisma.write.dispatchSession.updateMany({
      where: { tripId, status: DispatchSessionStatus.OPEN },
      data: { status },
    });
    return res.count;
  }
}
