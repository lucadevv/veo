/**
 * PaymentModule — composition root del puerto PaymentGateway (ADR-014 §5.5 · INTEGRACIONES port+adapter).
 * Cablea el token `PAYMENT_GATEWAY` (del que depende el dominio) a un gateway COMPUESTO que delega cada
 * operación a su transporte real:
 *  - charge / getDebt → RestPaymentGateway (REST firmado service-rail · PAYMENT_INTERNAL_URL).
 *  - getPayment       → GrpcPaymentReader (gRPC GetPayment · PAYMENT_GRPC_URL).
 *
 * El dueño del transporte vive en el ADAPTER; el dominio (BookingsService) sólo conoce el contrato del
 * puerto. En tests se inyecta FakePaymentGateway (mismo contrato). DI, no cableado duro.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway.port';
import { RestPaymentGateway } from './rest-payment-gateway';
import { GrpcPaymentReader } from './grpc-payment-reader';
import type { Env } from '../../config/env.schema';

/**
 * Gateway COMPUESTO: une los dos transportes (REST para comandos/deuda, gRPC para la lectura por id) detrás
 * de un único contrato `PaymentGateway`. El dominio no sabe —ni le importa— que charge es REST y getPayment
 * es gRPC: ese detalle vive acá, en el borde.
 */
class CompositePaymentGateway implements PaymentGateway {
  constructor(
    private readonly rest: RestPaymentGateway,
    private readonly grpc: GrpcPaymentReader,
  ) {}

  charge(input: Parameters<PaymentGateway['charge']>[0]): ReturnType<PaymentGateway['charge']> {
    return this.rest.charge(input);
  }

  getDebt(passengerId: string): ReturnType<PaymentGateway['getDebt']> {
    return this.rest.getDebt(passengerId);
  }

  getPayment(paymentId: string): ReturnType<PaymentGateway['getPayment']> {
    return this.grpc.getPayment(paymentId);
  }
}

const paymentGatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PaymentGateway => {
    const secret = config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET');
    const rest = new RestPaymentGateway(config.getOrThrow<string>('PAYMENT_INTERNAL_URL'), secret);
    const grpc = new GrpcPaymentReader(config.getOrThrow<string>('PAYMENT_GRPC_URL'), secret);
    return new CompositePaymentGateway(rest, grpc);
  },
};

@Module({
  providers: [paymentGatewayProvider],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentModule {}
