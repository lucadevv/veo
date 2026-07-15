/**
 * IdentityModule — proveedor ÚNICO de los puertos de identity (clientes gRPC SALIENTES a identity-service):
 * IDENTITY_CLIENT (GetDriver, single — gates de publish/approve/reserve) + IDENTITY_BATCH_CLIENT (GetDriversByIds,
 * batch — enriquecimiento anti-N+1 de la búsqueda). Antes cada módulo que necesitaba identity cableaba su PROPIO
 * provider con la misma factory `new GrpcIdentityClient(url, secret)` → copias que podían driftear (si una
 * superficie cambia TLS/el nombre del env del secret, la otra queda atrás → dos gates apuntando a identity
 * distinto). Acá vive UNA sola vez (espejo de FleetModule). Los servicios dependen de los PUERTOS, no de las
 * clases gRPC — en tests se inyecta un fake del mismo contrato.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IDENTITY_CLIENT } from './identity-client.port';
import { GrpcIdentityClient } from './grpc-identity-client';
import { IDENTITY_BATCH_CLIENT } from './identity-batch-client.port';
import { GrpcIdentityBatchClient } from './grpc-identity-batch-client';
import type { Env } from '../config/env.schema';

const identityClientProvider: Provider = {
  provide: IDENTITY_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new GrpcIdentityClient(
      config.getOrThrow<string>('IDENTITY_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

const identityBatchClientProvider: Provider = {
  provide: IDENTITY_BATCH_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new GrpcIdentityBatchClient(
      config.getOrThrow<string>('IDENTITY_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

@Module({
  providers: [identityClientProvider, identityBatchClientProvider],
  exports: [IDENTITY_CLIENT, IDENTITY_BATCH_CLIENT],
})
export class IdentityModule {}
