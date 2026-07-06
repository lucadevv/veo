/**
 * DriverPaymentsService — lógica del HARD purge en cascada de TODO el dinero de un conductor (DEV-only,
 * orquestado por el admin-bff con el guard de historial aguas arriba). Borra REALMENTE, en UNA
 * transacción, SIN dejar huérfanos.
 *
 * ⚠️ DIFERENCIA CON EL DERECHO AL OLVIDO (PROD · BR-S06): el `UserDeletedConsumer` ANONIMIZA el libro
 * financiero (obligación contable: payments/payouts NO se borran, se purga la PII). ESTO es OTRA cosa: el
 * HARD purge de DEV que el superadmin dispara sobre data de PRUEBA — acá SÍ se BORRAN las filas. En PROD
 * el guard de trips del admin-bff corta antes y este endpoint nunca se invoca para un conductor operado.
 *
 * INVARIANTE DE ID (verificado contra la DB real — payments/payouts confirmados, el resto vacío pero el
 * diseño del schema es consistente): las 5 tablas indexadas por `driver_id` usan el id de PERFIL Driver de
 * identity (= `Trip.driverId`, NO el userId); las 4 indexadas por `user_id` usan el `User.id` de identity.
 * Por eso el endpoint recibe AMBOS ids.
 *
 * ORDEN DE BORRADO (FK reales en payment, verificadas):
 *   - `payments` ← `refunds`, `tip_additions` (FK payment_id): los hijos PRIMERO, indexados por los ids de
 *     los payments del conductor.
 *   - `user_credits` ← `user_credit_entries` (FK user_id): las entries PRIMERO (también van por user_id).
 *   - `cancellation_penalties` / `incentive_progress` / `incentive_trip_credits` / `payouts`: sin hijos →
 *     borrado directo. `promo_redemptions` / `wallet_affiliations`: sin hijos → directo por user_id.
 *   - NUNCA tocamos `incentives` ni `promotions` (catálogo compartido): solo sus filas POR conductor/usuario.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';

/** Ids del conductor para el HARD purge del dinero: driverId (5 tablas) + userId (4 tablas). */
export interface DriverPaymentsPurgeIds {
  driverId: string;
  userId: string;
}

/**
 * Contadores por tabla del HARD purge del dinero de un conductor (observabilidad/degradación honesta).
 * Agrupados por el id que indexa cada tabla.
 */
export interface DriverPaymentsPurgeView {
  driverId: string;
  userId: string;
  byDriverId: {
    cancellationPenalties: number;
    incentiveProgress: number;
    incentiveTripCredits: number;
    payments: number;
    payouts: number;
    /** Hijos de payments borrados (no son tablas por driver_id, pero los purgamos para no dejar huérfanos). */
    refunds: number;
    tipAdditions: number;
  };
  byUserId: {
    promoRedemptions: number;
    userCreditEntries: number;
    userCredits: number;
    walletAffiliations: number;
  };
}

@Injectable()
export class DriverPaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Borra TODO el dinero del conductor en UNA transacción. Idempotente: re-correr sobre un conductor ya
   * purgado devuelve contadores en 0 (deleteMany no falla sin filas). NO emite eventos: borrado
   * administrativo de data de prueba (DEV), no un hecho de dominio.
   */
  async purgeForDriver(ids: DriverPaymentsPurgeIds): Promise<DriverPaymentsPurgeView> {
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

      // DriverDebt referencia paymentId (soft ref) → se borra ANTES de los payments. FALTABA en el purge:
      // dejaba filas de deuda huérfanas (viola el invariante "sin huérfanos" del borrado de prueba DEV).
      const driverDebts = await tx.driverDebt.deleteMany({ where: { driverId } });
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
