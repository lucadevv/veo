/**
 * IdentityModule — adapta el cliente gRPC de identity-service al puerto `IdentityClient`.
 *
 * Provee `IDENTITY_CLIENT` para resolver `driverId → userId` en los pushes que targetean al conductor por
 * su `Driver.id` (ADR-015 D7 · payout.processed). Mismo provider local que en booking-service: cada módulo
 * lo cablea local — el consumer depende del PUERTO `IDENTITY_CLIENT`, no de la clase gRPC (en tests se
 * inyecta un fake del mismo contrato).
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IDENTITY_CLIENT, type IdentityClient } from './identity-client.port';
import { GrpcIdentityClient } from './grpc-identity-client';
import type { Env } from '../../config/env.schema';

const identityClientProvider: Provider = {
  provide: IDENTITY_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): IdentityClient =>
    new GrpcIdentityClient(
      config.getOrThrow<string>('IDENTITY_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

@Module({
  providers: [identityClientProvider],
  exports: [IDENTITY_CLIENT],
})
export class IdentityModule {}
