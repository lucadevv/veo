/**
 * Controlador gRPC de payment (paquete veo.payment.v1.PaymentService).
 * Lectura síncrona de un pago para otros servicios. Devuelve `found=false` en vez de lanzar.
 */
import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, INTERNAL_IDENTITY_ALLOWED_AUDIENCES, type InternalAudience } from '@veo/auth';
import { PrismaService } from '../infra/prisma.service';
import { deriveTripChargeDedupKey } from '../payments/payment.policy';
import type { Payment } from '../generated/prisma';
import type { Env } from '../config/env.schema';

interface GetPaymentRequest {
  id: string;
}

interface GetPaymentByTripRequest {
  tripId: string;
}

interface GetUserCreditRequest {
  userId: string;
}

interface UserCreditReply {
  balanceCents: number;
}

interface PaymentReply {
  id: string;
  tripId: string;
  method: string;
  status: string;
  amountCents: number;
  grossCents: number;
  commissionCents: number;
  feeCents: number;
  tipCents: number;
  externalRef: string;
  found: boolean;
  // Checkout asíncrono (ProntoPaga). "" cuando no aplica (proto3 string default).
  externalUid: string;
  checkoutUrl: string;
  qrCode: string;
  deepLink: string;
  cip: string;
  checkoutExpiresAt: string;
  // Razón estructurada del fallo del cobro (failureReason del Payment). "" cuando no hubo fallo.
  failureReason: string;
}

const EMPTY: PaymentReply = {
  id: '',
  tripId: '',
  method: '',
  status: '',
  amountCents: 0,
  grossCents: 0,
  commissionCents: 0,
  feeCents: 0,
  tipCents: 0,
  externalRef: '',
  found: false,
  externalUid: '',
  checkoutUrl: '',
  qrCode: '',
  deepLink: '',
  cip: '',
  checkoutExpiresAt: '',
  failureReason: '',
};

@Controller()
export class PaymentGrpcController {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    @Inject(INTERNAL_IDENTITY_ALLOWED_AUDIENCES)
    private readonly allowedAudiences: readonly InternalAudience[],
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  /** Rechaza la RPC si la metadata no trae una identidad interna firmada (HMAC) válida. */
  private requireIdentity(metadata: Metadata): void {
    const identity = verifyGrpcIdentity(metadata, this.secret, { allowedAudiences: this.allowedAudiences });
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
  }

  @GrpcMethod('PaymentService', 'GetPayment')
  async getPayment({ id }: GetPaymentRequest, metadata: Metadata): Promise<PaymentReply> {
    this.requireIdentity(metadata);
    const p = await this.prisma.read.payment.findUnique({ where: { id } });
    if (!p) return EMPTY;
    return this.toReply(p);
  }

  /**
   * Cobro CANÓNICO de un viaje, por tripId (re-entrada del recibo). Resuelve por la dedupKey
   * determinista del cobro del viaje (`trip-completed:{tripId}`, deriveTripChargeDedupKey) — la MISMA
   * que el consumer de `trip.completed` y el cobro manual usan, así que apunta SIEMPRE al único Payment
   * del cobro del viaje (UNIQUE), sin ambigüedad con otras filas que compartan tripId. found=false si el
   * viaje aún no tiene cobro. El anti-IDOR (¿el viaje es del pasajero?) vive en el BFF, no acá.
   */
  @GrpcMethod('PaymentService', 'GetPaymentByTrip')
  async getPaymentByTrip(
    { tripId }: GetPaymentByTripRequest,
    metadata: Metadata,
  ): Promise<PaymentReply> {
    this.requireIdentity(metadata);
    const p = await this.prisma.read.payment.findUnique({
      where: { dedupKey: deriveTripChargeDedupKey(tripId) },
    });
    if (!p) return EMPTY;
    return this.toReply(p);
  }

  /**
   * Saldo de crédito GASTABLE del usuario (redención de referidos · Ola 2A · Lote C). Lectura síncrona
   * para el BFF: el pasajero ve "tenés S/X de crédito". 0 si no tiene fila de saldo. El anti-IDOR (que el
   * userId sea el del JWT del pasajero, no uno arbitrario) vive en el BFF, igual que en GetPaymentByTrip.
   */
  @GrpcMethod('PaymentService', 'GetUserCredit')
  async getUserCredit(
    { userId }: GetUserCreditRequest,
    metadata: Metadata,
  ): Promise<UserCreditReply> {
    this.requireIdentity(metadata);
    const credit = await this.prisma.read.userCredit.findUnique({ where: { userId } });
    return { balanceCents: credit?.balanceCents ?? 0 };
  }

  /** Mapea la fila Payment al contrato gRPC PaymentReply (found=true). */
  private toReply(p: Payment): PaymentReply {
    return {
      id: p.id,
      tripId: p.tripId,
      method: p.method,
      status: p.status,
      amountCents: p.amountCents,
      grossCents: p.grossCents,
      commissionCents: p.commissionCents,
      feeCents: p.feeCents,
      tipCents: p.tipCents,
      externalRef: p.externalRef ?? '',
      found: true,
      // Checkout asíncrono: proto3 no distingue null de "" → emitimos "" cuando la columna es null.
      // El BFF las re-mapea a null en el PaymentView público (recibo).
      externalUid: p.externalUid ?? '',
      checkoutUrl: p.checkoutUrl ?? '',
      qrCode: p.qrCode ?? '',
      deepLink: p.deepLink ?? '',
      cip: p.cip ?? '',
      checkoutExpiresAt: p.checkoutExpiresAt ? p.checkoutExpiresAt.toISOString() : '',
      // proto3 no distingue null de "": emitimos "" cuando no hubo fallo. El BFF la re-mapea a null.
      failureReason: p.failureReason ?? '',
    };
  }
}
