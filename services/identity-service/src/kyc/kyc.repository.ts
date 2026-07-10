/**
 * KycRepository — ÚNICO punto de acceso Prisma del KYC del PASAJERO (schema 'identity'). Espeja el mold de
 * payment/rating: read/write split, OUTBOX-EN-TRANSACCIÓN y métodos con NOMBRES DE DOMINIO — nunca filtra
 * `PrismaClient` crudo al service.
 *
 * SEAM con KycService: la LÓGICA DE DOMINIO (self-match en una pasada, decisión liveness+score, máquina de
 * estados KYC, no-persistir en rechazo) vive ENTERA en el service. La marca VERIFIED + el embedding + el evento
 * `user.kyc_verified` van en la MISMA tx (outbox-en-transacción · FOUNDATION §6).
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { KycStatus, Prisma, type User } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type KycTx = Prisma.TransactionClient;

@Injectable()
export class KycRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Usuario por id (carga del pasajero: type + tombstone + kycStatus). Réplica. */
  findUserById(id: string): Promise<User | null> {
    return this.prisma.read.user.findUnique({ where: { id } });
  }

  // ── Transacciones (primary · unit-of-work) ────────────────────────────────────────────────────────────

  /** Dueño del `$transaction` (write). El service ORQUESTA el assert de máquina + la marca + el evento. */
  runInTransaction<T>(work: (tx: KycTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: KycTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  /**
   * Marca el KYC del pasajero VERIFIED (status HARDCODEADO) + persiste el embedding de referencia y el momento,
   * DENTRO de la tx. El service aporta el embedding computado y el `verifiedAt`. Atómico con el evento.
   */
  async markKycVerifiedTx(
    tx: KycTx,
    userId: string,
    embedding: number[],
    verifiedAt: Date,
  ): Promise<void> {
    await tx.user.update({
      where: { id: userId },
      data: {
        kycStatus: KycStatus.VERIFIED,
        faceEmbedding: embedding,
        kycVerifiedAt: verifiedAt,
      },
    });
  }
}
