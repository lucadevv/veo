/**
 * Pagos y payouts del conductor.
 *  - GET /payments/:id → lectura gRPC del pago.
 *  - GET /payouts      → lista de liquidaciones del conductor autenticado (REST).
 * El driverId se resuelve desde el userId vía identity (GetDriverByUser); el cliente no lo provee.
 */
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import type { DriverReply, PaymentReply } from '../common/grpc-replies';
import type { PaymentView } from './dto/payments.dto';

function emptyToNull(value: string): string | null {
  return value ? value : null;
}

export function toPaymentView(payment: PaymentReply): PaymentView {
  return {
    id: payment.id,
    tripId: payment.tripId,
    method: payment.method,
    status: payment.status,
    amountCents: payment.amountCents,
    grossCents: payment.grossCents,
    commissionCents: payment.commissionCents,
    feeCents: payment.feeCents,
    externalRef: emptyToNull(payment.externalRef),
  };
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
  ) {}

  async getPayment(id: string, identity: AuthenticatedUser): Promise<PaymentView> {
    // ANTI-IDOR/anti-enumeración: el gRPC GetPayment es getter CRUDO por id (el contrato deja el ownership
    // al BFF). Verificamos PRIMERO que el cobro es de ESTE conductor (driverId resuelto del perfil)
    // leyéndolo por REST interno (trae driverId); ajeno/inexistente → 404 (no 403, no filtra existencia).
    // Sin esto, cualquier id devolvía monto/método/externalRef de un pago ajeno.
    const { identity: signedIdentity, driverId } = await this.resolveDriver(identity);
    let owner: { driverId?: string | null };
    try {
      owner = await this.rest
        .client('payment')
        .get<{ driverId?: string | null }>(`/payments/${id}`, { identity: signedIdentity });
    } catch {
      throw new NotFoundError('Pago no encontrado');
    }
    if (!owner.driverId || owner.driverId !== driverId) {
      throw new NotFoundError('Pago no encontrado');
    }
    const payment = await this.grpc.call<PaymentReply>('payment', 'GetPayment', { id }, identity);
    if (!payment.found) throw new NotFoundError('Pago no encontrado');
    return toPaymentView(payment);
  }

  /** Lista los payouts del conductor autenticado (filtrado por su driverId resuelto). */
  async listMyPayouts(identity: AuthenticatedUser): Promise<unknown> {
    const { identity: signedIdentity, driverId } = await this.resolveDriver(identity);
    return this.rest
      .client('payouts')
      .get('/payouts', { identity: signedIdentity, query: { driverId } });
  }

  /**
   * Resuelve el driverId del usuario autenticado y lo adjunta a la identidad propagada, para que el
   * RestGateway lo firme (HMAC) en la identidad interna y payment-service pueda verificar propiedad
   * sin confiar en un driverId arbitrario del query (anti-IDOR).
   */
  private async resolveDriver(
    identity: AuthenticatedUser,
  ): Promise<{ identity: AuthenticatedUser; driverId: string }> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found)
      throw new NotFoundError('No existe un perfil de conductor para este usuario');
    return { identity: { ...identity, driverId: driver.id }, driverId: driver.id };
  }
}
