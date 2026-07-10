/**
 * PayoutPollRepository — ÚNICO punto de acceso Prisma del POLL FALLBACK del desembolso (money-OUT · ADR-015
 * §4.2). Espeja el estilo repo-owned de `commission.repository.ts` para acceso simple: una sola lectura de la
 * réplica, con el INVARIANTE de reconciliación CRISTALIZADO en el WHERE (ancla por `dedupKey`, el claim marker
 * SIEMPRE presente — no por `externalRef`, que puede faltar por orfandad). La aplicación del desenlace la hace
 * `PayoutsService.applyPayoutDisbursementResult` (dominio), no este repo.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { PayoutStatus } from '../generated/prisma';

/** Payout PROCESSING candidato a reconciliar por poll: el mínimo que el barrido necesita (id + anclas + edad). */
export interface ProcessingPayoutForPoll {
  id: string;
  dedupKey: string | null;
  externalRef: string | null;
  updatedAt: Date;
}

@Injectable()
export class PayoutPollRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hasta `batch` payouts PROCESSING RECLAMADOS (con `dedupKey`) oldest-first — el ancla es el claim marker,
   * NO el `externalRef` (que puede faltar por orfandad de un crash post-claim). Escanea TODO PROCESSING (sin
   * ventana temporal: los viejos primero), la ventana de gracia la decide el service (recuperación por crash). Réplica.
   */
  findProcessingPayoutsForPoll(batch: number): Promise<ProcessingPayoutForPoll[]> {
    return this.prisma.read.payout.findMany({
      where: {
        status: PayoutStatus.PROCESSING,
        dedupKey: { not: null },
      },
      select: { id: true, dedupKey: true, externalRef: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: batch,
    });
  }
}
