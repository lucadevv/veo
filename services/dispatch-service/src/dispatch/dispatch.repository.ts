/**
 * Puerto + adaptador Prisma de DispatchService (FOUNDATION §10: el repositorio es el ÚNICO dueño de
 * Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde del panic.repository y del
 * dispatch-radius-config.repository (token DI + interfaz + adaptador con cliente dual read/write).
 *
 * Las lecturas de `DispatchMatch` son métodos del puerto. Las transacciones de dominio (accept/reject/
 * retract de ofertas hermanas) se abren con `runInTx`: el CUERPO transaccional —CAS con status-guard +
 * `outboxEvent.create` en la MISMA tx (FOUNDATION §6)— SIGUE viviendo en el service, que recibe el
 * cliente de transacción. El tx se tipa como `Prisma.TransactionClient` (el real): los cuerpos combinan
 * varias operaciones sobre `dispatchMatch` con la creación de outbox, que exige los delegates completos.
 */
import { Injectable } from '@nestjs/common';
import { DispatchOutcome } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type DispatchMatch } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const DISPATCH_REPO = Symbol('DISPATCH_REPO');

/** Proyección mínima de una oferta hermana viva (broadcast EMERGENCY). */
export type LiveSiblingOffer = Pick<DispatchMatch, 'id' | 'driverId'>;

/** Puerto: el DispatchService depende de esto, NO de Prisma. */
export interface DispatchRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (CAS + outbox en la
   * MISMA tx) vive en el service; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /** Lee un match por id desde la réplica (read). `null` si no existe. */
  findMatchById(matchId: string): Promise<DispatchMatch | null>;
  /**
   * Ofertas HERMANAS vivas (OFFERED) de un viaje, excluida la ganadora (broadcast EMERGENCY). Read con
   * select acotado (id + driverId) — lo que la retracción necesita.
   */
  findLiveSiblingOffers(tripId: string, winnerMatchId: string): Promise<LiveSiblingOffer[]>;
  /** Match ACEPTADO más reciente de un viaje (read); resuelve "quién está asignado". `null` si ninguno. */
  findAcceptedMatchForTrip(tripId: string): Promise<DispatchMatch | null>;
}

@Injectable()
export class PrismaDispatchRepository implements DispatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findMatchById(matchId: string): Promise<DispatchMatch | null> {
    return this.prisma.read.dispatchMatch.findUnique({ where: { id: matchId } });
  }

  findLiveSiblingOffers(tripId: string, winnerMatchId: string): Promise<LiveSiblingOffer[]> {
    return this.prisma.read.dispatchMatch.findMany({
      where: { tripId, outcome: DispatchOutcome.OFFERED, id: { not: winnerMatchId } },
      select: { id: true, driverId: true },
    });
  }

  findAcceptedMatchForTrip(tripId: string): Promise<DispatchMatch | null> {
    return this.prisma.read.dispatchMatch.findFirst({
      where: { tripId, outcome: DispatchOutcome.ACCEPTED },
      orderBy: { respondedAt: 'desc' },
    });
  }
}
