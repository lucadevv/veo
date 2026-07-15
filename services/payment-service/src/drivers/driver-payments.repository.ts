/**
 * DriverPaymentsRepository — ÚNICO punto de acceso Prisma del HARD purge en cascada del dinero de un conductor
 * (DEV-only). Estilo repo-owned (`commission.repository.ts`): el purge es una SECUENCIA de deletes en línea recta
 * SIN decisión de dominio interleavada (ni CAS, ni outbox, ni idempotencia por dedupKey) → el repo es dueño de la
 * `$transaction` entera. Lo único "lógico" es el ORDEN FK-safe de borrado, que es una invariante de persistencia y
 * por eso vive acá. La distinción de dominio (DEV hard-purge vs derecho-al-olvido de PROD) la documenta el service.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import type { DriverPaymentsPurgeIds, DriverPaymentsPurgeView } from './driver-payments.service';

@Injectable()
export class DriverPaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Borra TODO el dinero del conductor en UNA transacción, SIN dejar huérfanos. Idempotente: re-correr sobre un
   * conductor ya purgado devuelve contadores en 0 (deleteMany no falla sin filas).
   *
   * ORDEN DE BORRADO (FK reales en payment, verificadas):
   *   - `payments` ← `refunds`, `tip_additions` (FK payment_id): los hijos PRIMERO, indexados por los ids de los
   *     payments del conductor.
   *   - `driver_debts` / `driver_credits`: soft-ref a un payment (paymentId / sourcePaymentId) → antes de payments.
   *   - `user_credits` ← `user_credit_entries` (FK user_id): las entries PRIMERO.
   *   - el resto: sin hijos → borrado directo por driver_id / user_id.
   *   - NUNCA se tocan `incentives` ni `promotions` (catálogo compartido): solo las filas POR conductor/usuario.
   */
  purgeDriverMoneyCascade(ids: DriverPaymentsPurgeIds): Promise<DriverPaymentsPurgeView> {
    const { driverId, userId } = ids;
    return this.prisma.write.$transaction(async (tx) => {
      // ── Tablas por driver_id ──
      // Hijos de payments PRIMERO (FK payment_id): resolvemos los ids de los payments del conductor.
      const driverPayments = await tx.payment.findMany({
        where: { driverId },
        select: { id: true },
      });
      const paymentIds = driverPayments.map((p) => p.id);

      const refunds =
        paymentIds.length > 0
          ? await tx.refund.deleteMany({ where: { paymentId: { in: paymentIds } } })
          : { count: 0 };
      const tipAdditions =
        paymentIds.length > 0
          ? await tx.tipAddition.deleteMany({ where: { paymentId: { in: paymentIds } } })
          : { count: 0 };

      // DriverDebt y su gemela DriverCredit referencian un payment por soft-ref → se borran ANTES de los payments.
      const driverDebts = await tx.driverDebt.deleteMany({ where: { driverId } });
      const driverCredits = await tx.driverCredit.deleteMany({ where: { driverId } });
      const payments = await tx.payment.deleteMany({ where: { driverId } });
      const payouts = await tx.payout.deleteMany({ where: { driverId } });
      const cancellationPenalties = await tx.cancellationPenalty.deleteMany({
        where: { driverId },
      });
      const incentiveProgress = await tx.incentiveProgress.deleteMany({ where: { driverId } });
      const incentiveTripCredits = await tx.incentiveTripCredit.deleteMany({ where: { driverId } });

      // ── Tablas por user_id ──
      // Entries del crédito PRIMERO (FK user_id → user_credits), luego el saldo.
      const userCreditEntries = await tx.userCreditEntry.deleteMany({ where: { userId } });
      const userCredits = await tx.userCredit.deleteMany({ where: { userId } });
      const promoRedemptions = await tx.promoRedemption.deleteMany({ where: { userId } });
      const walletAffiliations = await tx.walletAffiliation.deleteMany({ where: { userId } });

      return {
        driverId,
        userId,
        byDriverId: {
          cancellationPenalties: cancellationPenalties.count,
          driverCredits: driverCredits.count,
          driverDebts: driverDebts.count,
          incentiveProgress: incentiveProgress.count,
          incentiveTripCredits: incentiveTripCredits.count,
          payments: payments.count,
          payouts: payouts.count,
          refunds: refunds.count,
          tipAdditions: tipAdditions.count,
        },
        byUserId: {
          promoRedemptions: promoRedemptions.count,
          userCreditEntries: userCreditEntries.count,
          userCredits: userCredits.count,
          walletAffiliations: walletAffiliations.count,
        },
      };
    });
  }
}
