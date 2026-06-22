import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingsService } from './bookings.service';
import { BookingsRepository } from './bookings.repository';
import { BookingsController } from './bookings.controller';
import { PaymentModule } from '../ports/payment/payment.module';
import { IDENTITY_CLIENT } from '../identity/identity-client.port';
import { GrpcIdentityClient } from '../identity/grpc-identity-client';
import type { Env } from '../config/env.schema';

/**
 * Cliente gRPC a identity (GetDriver) para el GATE de approve/reject (F3b · ADR-014 §8): re-valida que el
 * conductor sigue ACTIVO/no-suspendido antes de operar sus solicitudes (fail-closed). Mismo provider local
 * que en PublishedTripsModule (misma URL/secret); cada módulo lo cablea local — el servicio depende del PUERTO
 * IDENTITY_CLIENT, no de la clase gRPC (en tests se inyecta un fake del mismo contrato).
 */
const identityClientProvider: Provider = {
  provide: IDENTITY_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new GrpcIdentityClient(
      config.getOrThrow<string>('IDENTITY_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

@Module({
  // PaymentModule provee el token PAYMENT_GATEWAY (gate de deuda al reservar · §5.4; charge al aprobar · F3b).
  imports: [PaymentModule],
  providers: [BookingsService, BookingsRepository, identityClientProvider],
  controllers: [BookingsController],
  exports: [BookingsService],
})
export class BookingsModule {}
