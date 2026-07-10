/**
 * Puerto + adaptador Prisma de MatchingService (FOUNDATION §10). Dueño del acceso a `DispatchMatch` del
 * matching secuencial (FIXED) + broadcast (EMERGENCY): conteo/lectura de la ronda, creación de la oferta,
 * CAS de expiración, y la transacción del `dispatch.no_offers`. El estado DURABLE de la SESIÓN vive en
 * `matching-session.repository` (modelo `DispatchSession`, dueño el MatchingSessionStore).
 *
 * El cuerpo transaccional (encolar el outbox) SIGUE en el service vía `runInTx`; el tx se tipa como el real
 * `Prisma.TransactionClient` (usa el delegate `outboxEvent`). La construcción del `Prisma.Decimal` de
 * score/surge vive acá (el service pasa numbers): así Prisma no se filtra al núcleo de matching.
 */
import { Injectable } from '@nestjs/common';
import { DispatchOutcome } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type DispatchMatch } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const MATCHING_REPO = Symbol('MATCHING_REPO');

/** Proyección de un match de la ronda (broadcast usa outcome; el secuencial solo driverId). */
export type RoundMatch = Pick<DispatchMatch, 'driverId' | 'outcome'>;
/** Proyección de una oferta vencida (id + tripId para el CAS y el avance). */
export type ExpiredOffer = Pick<DispatchMatch, 'id' | 'tripId'>;

/** Datos de dominio de una oferta a persistir (el service pasa numbers; el repo envuelve el Decimal). */
export interface CreateOfferInput {
  id: string;
  tripId: string;
  driverId: string;
  score: number;
  attempt: number;
  surgeMultiplier: number;
}

/** Puerto: el MatchingService depende de esto, NO de Prisma. */
export interface MatchingRepository {
  /** Abre una transacción de ESCRITURA (encolar outbox `dispatch.no_offers`). El cuerpo vive en el service. */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /** Cuántas ofertas OFFERED (en vuelo) tiene el viaje (guarda "una oferta a la vez"). */
  countLiveOffers(tripId: string): Promise<number>;
  /** driverIds ya ofertados en ESTA ronda (offeredAt ≥ inicio de sesión). */
  findRoundDriverIds(tripId: string, since: Date): Promise<Pick<DispatchMatch, 'driverId'>[]>;
  /** Matches de ESTA ronda con outcome (broadcast: distingue vivos OFFERED de ya-respondidos). */
  findRoundMatches(tripId: string, since: Date): Promise<RoundMatch[]>;
  /** Ofertas OFFERED vencidas (offeredAt < cutoff), más viejas primero, tope `limit` (presupuesto del sweep). */
  findExpiredOffers(cutoff: Date, limit: number): Promise<ExpiredOffer[]>;
  /** CAS atómico OFFERED→TIMEOUT de una oferta. Devuelve cuántas filas cambió (0 = otra réplica la tomó). */
  timeoutOffer(matchId: string): Promise<number>;
  /** Persiste UNA oferta (DispatchMatch OFFERED) y la devuelve (el service lee su `offeredAt` real). */
  createOffer(input: CreateOfferInput): Promise<DispatchMatch>;
}

@Injectable()
export class PrismaMatchingRepository implements MatchingRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  countLiveOffers(tripId: string): Promise<number> {
    return this.prisma.read.dispatchMatch.count({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
  }

  findRoundDriverIds(tripId: string, since: Date): Promise<Pick<DispatchMatch, 'driverId'>[]> {
    return this.prisma.read.dispatchMatch.findMany({
      where: { tripId, offeredAt: { gte: since } },
      select: { driverId: true },
    });
  }

  findRoundMatches(tripId: string, since: Date): Promise<RoundMatch[]> {
    return this.prisma.read.dispatchMatch.findMany({
      where: { tripId, offeredAt: { gte: since } },
      select: { driverId: true, outcome: true },
    });
  }

  findExpiredOffers(cutoff: Date, limit: number): Promise<ExpiredOffer[]> {
    return this.prisma.read.dispatchMatch.findMany({
      where: { outcome: DispatchOutcome.OFFERED, offeredAt: { lt: cutoff } },
      select: { id: true, tripId: true },
      orderBy: { offeredAt: 'asc' },
      take: limit,
    });
  }

  async timeoutOffer(matchId: string): Promise<number> {
    const claimed = await this.prisma.write.dispatchMatch.updateMany({
      where: { id: matchId, outcome: DispatchOutcome.OFFERED },
      data: { outcome: DispatchOutcome.TIMEOUT, respondedAt: new Date() },
    });
    return claimed.count;
  }

  createOffer(input: CreateOfferInput): Promise<DispatchMatch> {
    return this.prisma.write.dispatchMatch.create({
      data: {
        id: input.id,
        tripId: input.tripId,
        driverId: input.driverId,
        score: new Prisma.Decimal(input.score),
        attempt: input.attempt,
        surgeMultiplier: new Prisma.Decimal(input.surgeMultiplier),
        outcome: DispatchOutcome.OFFERED,
      },
    });
  }
}
