/**
 * FleetModule — proveedor ÚNICO del puerto FLEET_CLIENT (cliente gRPC SALIENTE a fleet-service). Antes cada
 * módulo que necesitaba fleet (PublishedTripsModule para el gate de publish/detalle/búsqueda, BookingsModule
 * para el gate de operabilidad al reservar) cableaba su PROPIO provider con la misma factory → dos copias de la
 * misma construcción que podían driftear. Acá vive UNA sola vez: se construye con FLEET_GRPC_URL + el
 * INTERNAL_IDENTITY_SECRET (provistos por el ConfigService). Los servicios dependen del PUERTO FLEET_CLIENT, no
 * de la clase gRPC — en tests se inyecta un fake del mismo contrato.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FLEET_CLIENT } from './fleet-client.port';
import { GrpcFleetClient } from './grpc-fleet-client';
import type { Env } from '../config/env.schema';

const fleetClientProvider: Provider = {
  provide: FLEET_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new GrpcFleetClient(
      config.getOrThrow<string>('FLEET_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

@Module({
  providers: [fleetClientProvider],
  exports: [FLEET_CLIENT],
})
export class FleetModule {}
