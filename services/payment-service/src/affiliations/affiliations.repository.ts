/**
 * AffiliationsRepository — ÚNICO punto de acceso Prisma del agregado de afiliación de wallet (Yape On File,
 * schema 'payment'). Espeja `payments.repository.ts`/`payouts.repository.ts`: encapsula el read/write split
 * (réplica vs primary), el patrón OUTBOX-EN-TRANSACCIÓN (la transición de estado y el INSERT de su evento van en
 * la MISMA tx Prisma, FOUNDATION §6) y expone métodos con NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo
 * hacia el service.
 *
 * SEAM con AffiliationsService: la LÓGICA (idempotencia por estado, refresh defensivo /show, decisión de
 * emitir/no-emitir, purga de PII por derecho al olvido) vive ENTERA en el service. Este repo solo hace acceso a
 * datos y CRISTALIZA los INVARIANTES DE QUERY que NO deben poder cambiarse desde afuera:
 *   - los CAS optimistas de transición (`activate`/`expire`) llevan su predicado (`status = <estado leído>`)
 *     en el WHERE y su TARGET de transición (`ACTIVE` / `EXPIRED`) HARDCODEADO en el método — el service solo
 *     aporta el estado esperado y los campos computados (phoneMasked/walletUid) → dos caminos concurrentes
 *     (webhook + refresh) no pueden ambos emitir el evento (solo el que matchea el estado gana con count=1);
 *   - el evento `payment.affiliation_activated`/`_expired` se persiste al outbox DENTRO de la misma tx que su CAS.
 *
 * Como la activación/expiración interleavan lecturas y decisiones de dominio DENTRO de una misma transacción, el
 * repo expone `runInTransaction(work)` (dueño del `$transaction`) + métodos tx-scoped que reciben el `tx` opaco:
 * el service ORQUESTA la secuencia (CAS → relee → arma envelope → outbox) sin tocar nunca `this.prisma` ni
 * `tx.model.op`.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import {
  Prisma,
  AffiliationStatus,
  type WalletAffiliation,
} from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type AffiliationTx = Prisma.TransactionClient;

/** Clave natural de una afiliación (unique compuesto `userId_provider_wallet`). */
export interface AffiliationKey {
  userId: string;
  provider: string;
  wallet: string;
}

@Injectable()
export class AffiliationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ──────────────────────────────────────────────────────────────────────────────

  /** Afiliación por su clave natural (userId, provider, wallet). Réplica. */
  findByKey(key: AffiliationKey): Promise<WalletAffiliation | null> {
    return this.prisma.read.walletAffiliation.findUnique({
      where: {
        userId_provider_wallet: {
          userId: key.userId,
          provider: key.provider,
          wallet: key.wallet,
        },
      },
    });
  }

  /** Afiliación por id (correlación de webhook cuando trae nuestro id). Réplica. */
  findById(id: string): Promise<WalletAffiliation | null> {
    return this.prisma.read.walletAffiliation.findUnique({ where: { id } });
  }

  /** Afiliación por walletUid (correlación de webhook sin nuestro id). Réplica. */
  findByWalletUid(walletUid: string): Promise<WalletAffiliation | null> {
    return this.prisma.read.walletAffiliation.findFirst({ where: { walletUid } });
  }

  // ── Escrituras no transaccionales (primary) ─────────────────────────────────────────────────────────

  /** Upsert idempotente de la afiliación por su clave natural (create/reinicio a PROCESS). El service arma la data. */
  upsertByKey(
    key: AffiliationKey,
    update: Prisma.WalletAffiliationUncheckedUpdateInput,
    create: Prisma.WalletAffiliationUncheckedCreateInput,
  ): Promise<WalletAffiliation> {
    return this.prisma.write.walletAffiliation.upsert({
      where: {
        userId_provider_wallet: {
          userId: key.userId,
          provider: key.provider,
          wallet: key.wallet,
        },
      },
      update,
      create,
    });
  }

  /**
   * Update PLANO por id (revoke, EXPIRED por refresh, purga PII del derecho al olvido). El service arma el `data`
   * de la transición correspondiente; estos caminos NO emiten evento (no van en tx).
   */
  updateById(
    id: string,
    data: Prisma.WalletAffiliationUncheckedUpdateInput,
  ): Promise<WalletAffiliation> {
    return this.prisma.write.walletAffiliation.update({ where: { id }, data });
  }

  // ── Transacciones (primary · unit-of-work) ──────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service pasa `work`, que ORQUESTA el CAS de transición + la relectura +
   * el enqueue del outbox como una única unidad ACID (outbox-en-transacción).
   */
  runInTransaction<T>(work: (tx: AffiliationTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: AffiliationTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  /**
   * CAS de activación: `<estado leído>` → ACTIVE (el TARGET va HARDCODEADO; el estado esperado va en el WHERE).
   * Cierra el TOCTOU webhook↔refresh: dos caminos que leyeron PROCESS solo uno gana (count=1) y emite. El service
   * aporta el estado esperado + los campos computados (phoneMasked/walletUid).
   */
  casActivateInTx(
    tx: AffiliationTx,
    id: string,
    expectedStatus: AffiliationStatus,
    phoneMasked: string | null,
    walletUid: string | null,
  ): Promise<{ count: number }> {
    return tx.walletAffiliation.updateMany({
      where: { id, status: expectedStatus },
      data: { status: AffiliationStatus.ACTIVE, phoneMasked, walletUid },
    });
  }

  /**
   * CAS de expiración: `<estado leído>` → EXPIRED (TARGET HARDCODEADO; estado esperado en el WHERE). Cierra la
   * doble-emisión de `payment.affiliation_expired` entre webhooks concurrentes. El service aporta el walletUid.
   */
  casExpireInTx(
    tx: AffiliationTx,
    id: string,
    expectedStatus: AffiliationStatus,
    walletUid: string | null,
  ): Promise<{ count: number }> {
    return tx.walletAffiliation.updateMany({
      where: { id, status: expectedStatus },
      data: { status: AffiliationStatus.EXPIRED, walletUid },
    });
  }

  /** Relee la afiliación dentro de la tx (updateMany no devuelve la fila; base del envelope). */
  findByIdInTx(tx: AffiliationTx, id: string): Promise<WalletAffiliation> {
    return tx.walletAffiliation.findUniqueOrThrow({ where: { id } });
  }
}
