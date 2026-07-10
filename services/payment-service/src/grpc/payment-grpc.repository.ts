/**
 * Puerto + adaptador Prisma del `PaymentGrpcController` (FOUNDATION §10: ningún controller/service toca
 * `this.prisma` directo). El gRPC es un LECTOR cross-feature (recibo/estado del cobro + saldo de crédito para
 * los BFFs y booking): lee de DOS features (payments + credit), así que en vez de repartir sus consultas por
 * los repos de cada feature (que sirven a sus services) tiene su propio repo de lectura — MISMO criterio que el
 * repo propio del gRPC de fleet (`fleet-grpc.repository.ts`). Es READ-ONLY: no hay `runInTx`.
 *
 * FRESHNESS: las 4 lecturas son de DISPLAY (recibo del cobro, saldo de crédito del BFF), NO gates de dinero que
 * exijan el primario — todas van por la RÉPLICA (`this.prisma.read`), preservando EXACTAMENTE el eje que traía
 * el controller original (todas eran `this.prisma.read.*`). Por eso no hace falta el booleano `fresh` que sí usa
 * fleet (que lee un doc revocado en el gate reserve/approve del carpooling). La LÓGICA (dedupKey del cobro del
 * viaje, degradación honesta de la suma de propinas, mapeo al contrato gRPC) vive ENTERA en el controller.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import type { Payment, UserCredit } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const PAYMENT_GRPC_REPO = Symbol('PAYMENT_GRPC_REPO');

/** Puerto: el PaymentGrpcController depende de esto, NO de Prisma. */
export interface PaymentGrpcRepository {
  /** Pago por id (réplica). `null` si no existe — recibo/estado del cobro (GetPayment). */
  findPaymentById(id: string): Promise<Payment | null>;
  /** Cobro CANÓNICO de un viaje por su dedupKey determinista (réplica). `null` si el viaje aún no tiene cobro. */
  findPaymentByDedupKey(dedupKey: string): Promise<Payment | null>;
  /**
   * Σ de las propinas DIGITALES capturadas de un viaje (tip-Payments kind=TIP, status=CAPTURED · réplica).
   * Ya coalesa el `_sum` null (sin filas) a 0 — devuelve el total en centavos listo para sumar.
   */
  sumCapturedTipCentsByTrip(tripId: string): Promise<number>;
  /** Saldo de crédito gastable del usuario (réplica). `null` si no tiene fila de saldo (GetUserCredit). */
  findUserCreditByUser(userId: string): Promise<UserCredit | null>;
}

@Injectable()
export class PrismaPaymentGrpcRepository implements PaymentGrpcRepository {
  constructor(private readonly prisma: PrismaService) {}

  findPaymentById(id: string): Promise<Payment | null> {
    return this.prisma.read.payment.findUnique({ where: { id } });
  }

  findPaymentByDedupKey(dedupKey: string): Promise<Payment | null> {
    return this.prisma.read.payment.findUnique({ where: { dedupKey } });
  }

  async sumCapturedTipCentsByTrip(tripId: string): Promise<number> {
    const tipAgg = await this.prisma.read.payment.aggregate({
      where: { tripId, kind: 'TIP', status: 'CAPTURED' },
      _sum: { tipCents: true },
    });
    return tipAgg._sum.tipCents ?? 0;
  }

  findUserCreditByUser(userId: string): Promise<UserCredit | null> {
    return this.prisma.read.userCredit.findUnique({ where: { userId } });
  }
}
