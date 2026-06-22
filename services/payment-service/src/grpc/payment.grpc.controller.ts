/**
 * Controlador gRPC de payment (paquete veo.payment.v1.PaymentService).
 * Lectura síncrona de un pago para otros servicios. Devuelve `found=false` en vez de lanzar.
 */
import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import { verifyGrpcIdentity, InternalAudience, type InternalAudience as Rail } from '@veo/auth';
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

/**
 * Métodos gRPC de PaymentService scopeados POR RIEL (per-RPC · confused-deputy H7). Antes este controller
 * verificaba el HMAC contra el `ALLOWED_AUDIENCES` GLOBAL `[public, driver, admin]` de core.module — un set
 * único que dejaba pasar cualquiera de esos rieles a cualquier método, y que NO incluía `service-rail`. F3a
 * (ADR-014 §5.5) replica el patrón de identity-service (`GRPC_METHOD_AUDIENCES`): cada RPC declara EXACTAMENTE
 * qué rieles puede invocarla. El HMAC válido NO basta — el `aud` firmado del caller DEBE estar en la lista del
 * método o se rechaza fail-closed (PERMISSION_DENIED). Mapa tipado y centralizado, jamás un string mágico.
 *
 * Mínimo privilegio (decisión del dueño 2026-06-22):
 *  - GetPayment SUMA `service-rail`: booking-service lee el estado/recibo del cobro ya disparado (paymentId
 *    guardado en el Booking al aprobar · §5.4). Conserva los rieles previos (public/driver/admin) para los
 *    callers actuales del recibo (BFFs), que NO se rompen.
 *  - GetPaymentByTrip / GetUserCredit NO se abren a service-rail (mínimo privilegio): el carpooling correlaciona
 *    el Booking por el `tripId` opaco del evento `payment.captured`, no por GetPaymentByTrip. Siguen
 *    `[public, driver, admin]` exactamente como estaban (compat con los BFFs).
 */
export const GRPC_METHOD_AUDIENCES = {
  // GetPayment: recibo/estado del cobro. SUMA service-rail (booking lee el cobro del carpooling tras aprobar).
  GetPayment: [
    InternalAudience.PUBLIC_RAIL,
    InternalAudience.DRIVER_RAIL,
    InternalAudience.ADMIN_RAIL,
    InternalAudience.SERVICE_RAIL,
  ],
  // GetPaymentByTrip: recibo canónico por tripId. NO se abre a service-rail (compat exacta con el set previo).
  GetPaymentByTrip: [
    InternalAudience.PUBLIC_RAIL,
    InternalAudience.DRIVER_RAIL,
    InternalAudience.ADMIN_RAIL,
  ],
  // GetUserCredit: saldo de crédito del usuario (lectura del BFF). NO se abre a service-rail (compat exacta).
  GetUserCredit: [
    InternalAudience.PUBLIC_RAIL,
    InternalAudience.DRIVER_RAIL,
    InternalAudience.ADMIN_RAIL,
  ],
} as const satisfies Record<string, readonly Rail[]>;

type GrpcMethodName = keyof typeof GRPC_METHOD_AUDIENCES;

@Controller()
export class PaymentGrpcController {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  /**
   * Verifica el HMAC Y acota el RIEL emisor al conjunto permitido del MÉTODO (scoping per-RPC). Dos rechazos
   * honestos y distintos (espeja identity-service):
   *  - firma ausente/inválida → UNAUTHENTICATED (no probó quién es).
   *  - firma válida pero riel no autorizado para este método → PERMISSION_DENIED (probó quién es, no puede).
   */
  private requireIdentity(method: GrpcMethodName, metadata: Metadata): void {
    // Paso 1: firma. Sin allowedAudiences acá → distinguimos "no autenticado" de "autenticado sin permiso".
    const identity = verifyGrpcIdentity(metadata, this.secret);
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
    // Paso 2: riel. El `aud` firmado del caller debe estar en la lista del método (fail-closed).
    const allowed: readonly Rail[] = GRPC_METHOD_AUDIENCES[method];
    if (!allowed.includes(identity.aud)) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'Riel no autorizado para esta operación',
      });
    }
  }

  @GrpcMethod('PaymentService', 'GetPayment')
  async getPayment({ id }: GetPaymentRequest, metadata: Metadata): Promise<PaymentReply> {
    this.requireIdentity('GetPayment', metadata);
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
    this.requireIdentity('GetPaymentByTrip', metadata);
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
    this.requireIdentity('GetUserCredit', metadata);
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
