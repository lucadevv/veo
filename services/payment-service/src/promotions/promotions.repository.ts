/**
 * PromotionsRepository — ÚNICO punto de acceso Prisma del agregado de promociones/canjes (schema 'payment').
 * Espeja `payments.repository.ts`: encapsula el read/write split (réplica vs primary), el patrón
 * OUTBOX-EN-TRANSACCIÓN (la creación del canje y el INSERT de `promo.redeemed` van en la MISMA tx Prisma,
 * FOUNDATION §6) y expone métodos con NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo hacia el service.
 *
 * SEAM con PromotionsService: la LÓGICA DE DINERO (idempotencia por dedupKey/tripleta, evaluación del cupón,
 * decisión de rechazo por caps) vive ENTERA en el service. Este repo solo hace acceso a datos y CRISTALIZA los
 * INVARIANTES DE QUERY:
 *   - el COUNT DE USOS es el corazón del presupuesto del cupón; corre sobre el MISMO cliente que su contexto
 *     (réplica para el preview `validatePromo`, la TX serializada bajo advisory lock para `redeemPromo` — así el
 *     2º canje concurrente ve la inserción del 1º). El repo expone el count en AMBOS sabores (`…OnReplica` /
 *     `…InTx`) vía `PromoUsageCounter`, sin que el service toque `prisma.read` ni `tx.*`;
 *   - el advisory lock TRANSACCIONAL por promo (serializa canjes concurrentes del MISMO cupón) es un método propio;
 *   - `promo.redeemed` se persiste al outbox DENTRO de la misma tx que crea el canje.
 *
 * Como el canje interleava lock + count + creación + outbox DENTRO de una transacción, el repo expone
 * `runInTransaction(work)` (dueño del `$transaction`) + métodos tx-scoped que reciben el `tx` opaco: el service
 * ORQUESTA la secuencia sin tocar nunca `this.prisma` ni `tx.model.op`.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Promotion, type PromoRedemption } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type PromotionTx = Prisma.TransactionClient;

/**
 * Contador de usos de un cupón. El service lo orquesta (decide contar o no según el cap) sin conocer el cliente
 * subyacente: el repo lo cablea a la RÉPLICA (preview) o a la TX serializada (canje). Cristaliza los dos scans
 * ACOTADOS (findMany take vs count por índice).
 */
export interface PromoUsageCounter {
  /** Usos totales del cupón, CAPADOS a `cap` (findMany take → length): basta saber si se alcanzó el tope. */
  countCappedTotalUses(promotionId: string, cap: number): Promise<number>;
  /** Usos por-usuario del cupón (count sobre índice [promotionId, userId]). */
  countUserUses(promotionId: string, userId: string): Promise<number>;
}

@Injectable()
export class PromotionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ──────────────────────────────────────────────────────────────────────────────

  /** Promo por código (ya normalizado). Réplica. */
  findPromotionByCode(code: string): Promise<Promotion | null> {
    return this.prisma.read.promotion.findUnique({ where: { code } });
  }

  /** Canje por dedupKey (idempotencia principal del canje). Réplica. */
  findRedemptionByDedupKey(dedupKey: string): Promise<PromoRedemption | null> {
    return this.prisma.read.promoRedemption.findUnique({ where: { dedupKey } });
  }

  /** Canje por la tripleta (promo, usuario, viaje) — un único uso por viaje. Réplica. */
  findRedemptionByTriple(
    promotionId: string,
    userId: string,
    tripId: string,
  ): Promise<PromoRedemption | null> {
    return this.prisma.read.promoRedemption.findUnique({
      where: { promotionId_userId_tripId: { promotionId, userId, tripId } },
    });
  }

  /** Contador de usos sobre la RÉPLICA (preview `validatePromo`, no muta). */
  replicaUsageCounter(): PromoUsageCounter {
    return this.buildUsageCounter(this.prisma.read);
  }

  // ── Transacciones (primary · unit-of-work) ──────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service pasa `work`, que ORQUESTA el advisory lock + el count in-tx + la
   * evaluación + la creación del canje + el outbox como una única unidad ACID (outbox-en-transacción).
   */
  runInTransaction<T>(work: (tx: PromotionTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: PromotionTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  /**
   * Advisory lock TRANSACCIONAL por promo (misma clave `promo:<id>` que el diseño original): serializa los canjes
   * concurrentes del MISMO cupón, de modo que el count in-tx del 2º ya vea la inserción del 1º.
   */
  async acquirePromoAdvisoryLock(tx: PromotionTx, promotionId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`promo:${promotionId}`})::bigint)`;
  }

  /** Contador de usos sobre la TX serializada (canje `redeemPromo`, bajo el advisory lock). */
  txUsageCounter(tx: PromotionTx): PromoUsageCounter {
    return this.buildUsageCounter(tx);
  }

  /** Crea el canje DENTRO de la tx (atómico con el outbox). El service arma la data con la dedupKey. */
  createRedemptionInTx(
    tx: PromotionTx,
    data: Prisma.PromoRedemptionUncheckedCreateInput,
  ): Promise<PromoRedemption> {
    return tx.promoRedemption.create({ data });
  }

  // ── internos ────────────────────────────────────────────────────────────────────────────────────────

  /** Arma el `PromoUsageCounter` sobre un cliente dado (réplica o tx) — misma semántica de scan acotado en ambos. */
  private buildUsageCounter(client: Prisma.TransactionClient): PromoUsageCounter {
    return {
      countCappedTotalUses: (promotionId, cap) =>
        client.promoRedemption
          .findMany({ where: { promotionId }, take: cap, select: { id: true } })
          .then((rows) => rows.length),
      countUserUses: (promotionId, userId) =>
        client.promoRedemption.count({ where: { promotionId, userId } }),
    };
  }
}
