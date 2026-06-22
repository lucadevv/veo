/**
 * Adapter gRPC del puerto PaymentGateway — la LECTURA por paymentId (`GetPayment`, §5.4). Espejo EXACTO del
 * patrón de los clientes gRPC de booking (identity/fleet): el .proto canónico vive en packages/rpc/proto
 * (fuente única) y el shape del reply es el contrato compartido `PaymentReply`. El dominio NUNCA toca
 * @grpc/grpc-js — habla por el puerto; este adapter es el único que importa el cliente.
 *
 * RIEL: lectura de SISTEMA (booking lee el cobro ya disparado, sin usuario final) → `service-rail`. Firmamos
 * una identidad anónima de tipo 'passenger' (booking sirve el riel del pasajero) con audiencia service-rail;
 * payment scopea `GetPayment` per-RPC y la admite (ADR-014 §5.5 · GRPC_METHOD_AUDIENCES).
 *
 * La captura del cobro NO se lee por acá (llega por el evento `payment.captured`); este reader es para
 * leer estado/recibo puntual (F3b+). `found=false` si payment no tiene el pago (nunca lanza por "no existe").
 */
import { anonymousIdentity, grpcIdentityMetadata, InternalAudience } from '@veo/auth';
import { createGrpcClient, type PaymentReply, type GrpcServiceClient } from '@veo/rpc';
import {
  PaymentMethod,
  PaymentStatus,
  type PaymentView,
} from './payment-gateway.port';

const SERVICE_RAIL = InternalAudience.SERVICE_RAIL;

/** Mapea un valor crudo del wire al enum tipado correspondiente; '' si no es un miembro conocido. */
function toEnum<T extends string>(values: readonly string[], raw: string): T | '' {
  return values.includes(raw) ? (raw as T) : '';
}

export class GrpcPaymentReader {
  private readonly client: GrpcServiceClient;
  private readonly secret: string;

  constructor(paymentGrpcUrl: string, secret: string, deadlineMs = 2_000) {
    this.client = createGrpcClient('payment', { url: paymentGrpcUrl, deadlineMs });
    this.secret = secret;
  }

  async getPayment(paymentId: string): Promise<PaymentView> {
    const meta = grpcIdentityMetadata(anonymousIdentity('passenger'), this.secret, SERVICE_RAIL);
    const reply = await this.client.call<PaymentReply>('GetPayment', { id: paymentId }, meta);
    return {
      id: reply.id,
      tripId: reply.tripId,
      method: toEnum<PaymentMethod>(Object.values(PaymentMethod), reply.method),
      status: toEnum<PaymentStatus>(Object.values(PaymentStatus), reply.status),
      grossCents: reply.grossCents,
      amountCents: reply.amountCents,
      failureReason: reply.failureReason,
      found: reply.found,
    };
  }
}
