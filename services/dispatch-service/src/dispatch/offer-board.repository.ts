/**
 * Puerto + adaptador Prisma de OfferBoardService (FOUNDATION §10). El board y las ofertas EFÍMERAS viven en
 * Redis (OfferBoardStore); la DURABILIDAD del match (outbox + fila `DispatchMatch` ACCEPTED) es Postgres, y
 * ESE acceso vive acá. Las transacciones de dominio (accept → offer_accepted+match_found+record; el
 * reconciliador del residual hard-crash; el `emit` genérico de outbox) se abren con `runInTx`: el CUERPO
 * transaccional SIGUE en el service. El tx se tipa como el real `Prisma.TransactionClient` (usa el delegate
 * `dispatchMatch` + `outboxEvent`).
 */
import { Injectable } from '@nestjs/common';
import { DispatchOutcome } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type DispatchMatch } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const OFFER_BOARD_REPO = Symbol('OFFER_BOARD_REPO');

/** Par (tripId, driverId) por el que el reconciliador busca la fila ACCEPTED durable. */
export interface AcceptedMatchPair {
  tripId: string;
  driverId: string;
}
/** Proyección con el precio acordado durable (Finding #11: fuente de verdad del reconciliador). */
export type AcceptedMatchPrice = Pick<DispatchMatch, 'tripId' | 'driverId' | 'agreedPriceCents'>;

/** Puerto: el OfferBoardService depende de esto, NO de Prisma. */
export interface OfferBoardRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback (offer_accepted/match_found +
   * record ACCEPTED, o el outbox del emit/reconcile). El cuerpo vive en el service.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /**
   * Filas ACCEPTED durables de los pares (tripId, driverId) pendientes de reconciliar, en UNA sola query
   * (batch, evita el N+1). Devuelve tripId + driverId + agreedPriceCents (el precio real, nunca fabricado).
   */
  findAcceptedMatches(pairs: AcceptedMatchPair[]): Promise<AcceptedMatchPrice[]>;
}

@Injectable()
export class PrismaOfferBoardRepository implements OfferBoardRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findAcceptedMatches(pairs: AcceptedMatchPair[]): Promise<AcceptedMatchPrice[]> {
    return this.prisma.read.dispatchMatch.findMany({
      where: {
        outcome: DispatchOutcome.ACCEPTED,
        OR: pairs.map((p) => ({ tripId: p.tripId, driverId: p.driverId })),
      },
      select: { tripId: true, driverId: true, agreedPriceCents: true },
    });
  }
}
