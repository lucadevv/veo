/**
 * CreditRepository — ÚNICO punto de acceso Prisma del saldo de crédito gastable (schema 'payment'). Espeja
 * `payments.repository.ts`: encapsula el read/write split (réplica vs primary) y expone métodos con NOMBRES DE
 * DOMINIO — nunca filtra `PrismaClient` crudo hacia el service.
 *
 * SEAM con CreditService: la LÓGICA DE DINERO (idempotencia por sourceRef, orden guard-antes-de-increment,
 * reintento acotado de la carrera de saldo, degradación honesta a "sin crédito") vive ENTERA en el service. Este
 * repo solo hace acceso a datos y CRISTALIZA los INVARIANTES DE QUERY:
 *   - el CAS de gasto lleva su predicado `balanceCents >= applied` HARDCODEADO en el WHERE (el service solo aporta
 *     el `applied` computado) → nadie puede decrementar por debajo de cero (idempotencia financiera #3, CLAUDE §3);
 *   - la creación del movimiento (`UserCreditEntry`) es el GUARD de idempotencia: su UNIQUE(sourceRef) aborta la tx
 *     ENTERA si el evento/cobro ya se procesó (el increment/decrement de la misma tx NO ocurre).
 *
 * Como acreditar (upsert → guard → increment) y gastar (CAS decrement → guard) interleavan escrituras dentro de
 * una misma transacción ACID, el repo expone `runInTransaction(work)` (dueño del `$transaction`) + métodos
 * tx-scoped que reciben el `tx` opaco: el service ORQUESTA la secuencia sin tocar nunca `this.prisma` ni
 * `tx.model.op`.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type UserCredit, type UserCreditEntry } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type CreditTx = Prisma.TransactionClient;

@Injectable()
export class CreditRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ──────────────────────────────────────────────────────────────────────────────

  /** Movimiento del ledger por sourceRef (idempotencia del gasto: re-run / ganador de la carrera). Réplica. */
  findEntryBySourceRef(sourceRef: string): Promise<UserCreditEntry | null> {
    return this.prisma.read.userCreditEntry.findUnique({ where: { sourceRef } });
  }

  /** Saldo gastable del usuario (base del CAS de gasto). Réplica. */
  findCreditByUser(userId: string): Promise<UserCredit | null> {
    return this.prisma.read.userCredit.findUnique({ where: { userId } });
  }

  // ── Transacciones (primary · unit-of-work) ──────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service pasa `work`, que ORQUESTA las escrituras tx-scoped (upsert →
   * guard → increment, o CAS decrement → guard) como una única unidad ACID.
   */
  runInTransaction<T>(work: (tx: CreditTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Asegura la fila de saldo del usuario (no-op si existe) para satisfacer el FK del movimiento. Data hardcodeada. */
  async ensureCreditRowInTx(tx: CreditTx, userId: string): Promise<void> {
    await tx.userCredit.upsert({
      where: { userId },
      create: { userId, balanceCents: 0 },
      update: {},
    });
  }

  /**
   * Crea el movimiento del ledger DENTRO de la tx (acreditación de referido o gasto en el cobro). Es el GUARD de
   * idempotencia: el UNIQUE(sourceRef) aborta la tx si el evento/cobro ya se procesó. El service arma la data.
   */
  async createEntryInTx(
    tx: CreditTx,
    data: Prisma.UserCreditEntryUncheckedCreateInput,
  ): Promise<void> {
    await tx.userCreditEntry.create({ data });
  }

  /** Acredita el saldo DENTRO de la tx (increment atómico), tras pasar el guard de idempotencia. */
  async incrementBalanceInTx(tx: CreditTx, userId: string, amountCents: number): Promise<void> {
    await tx.userCredit.update({
      where: { userId },
      data: { balanceCents: { increment: amountCents } },
    });
  }

  /**
   * CAS de gasto: decrementa el saldo SOLO si SIGUE alcanzando (`balanceCents >= applied` HARDCODEADO en el WHERE) —
   * cierra la carrera con un gasto concurrente del mismo usuario (lost-update). count=0 ⇒ CAS miss (el service
   * reintenta con saldo fresco). El service solo aporta el `applied` computado.
   */
  casDecrementBalanceInTx(
    tx: CreditTx,
    userId: string,
    applied: number,
  ): Promise<{ count: number }> {
    return tx.userCredit.updateMany({
      where: { userId, balanceCents: { gte: applied } },
      data: { balanceCents: { decrement: applied } },
    });
  }
}
