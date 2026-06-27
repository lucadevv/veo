/**
 * PublishedTripsModule — el ciclo lado-conductor de la oferta de carpooling (publicar/editar/cancelar/
 * listar). Cablea los clientes gRPC SALIENTES de los gates F1a (identity + fleet) como providers locales
 * del módulo (mismo patrón que dispatch-service): cada uno se construye con su URL del ConfigService + el
 * INTERNAL_IDENTITY_SECRET (provisto global por CoreModule). El servicio depende de los PUERTOS
 * (IDENTITY_CLIENT/FLEET_CLIENT), no de las clases gRPC — en tests se inyecta un fake del mismo contrato.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PublishedTripsService,
  SEARCH_H3_CONFIG,
  type SearchH3Config,
} from './published-trips.service';
import { PublishedTripsRepository } from './published-trips.repository';
import { PublishedTripsController } from './published-trips.controller';
import { CostCapService } from './cost-cap.service';
import { CostPerKmConfigModule } from '../cost-per-km/cost-per-km.module';
import { MapsModule } from '../ports/maps/maps.module';
import { BookingsModule } from '../bookings/bookings.module';
import { IDENTITY_CLIENT } from '../identity/identity-client.port';
import { GrpcIdentityClient } from '../identity/grpc-identity-client';
import { IDENTITY_BATCH_CLIENT } from '../identity/identity-batch-client.port';
import { GrpcIdentityBatchClient } from '../identity/grpc-identity-batch-client';
import { FLEET_CLIENT } from '../fleet/fleet-client.port';
import { GrpcFleetClient } from '../fleet/grpc-fleet-client';
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

const fleetClientProvider: Provider = {
  provide: FLEET_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new GrpcFleetClient(
      config.getOrThrow<string>('FLEET_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

/**
 * Cliente gRPC BATCH a identity (F2): GetDriversByIds para enriquecer la BÚSQUEDA sin N+1. Misma URL/secret
 * que el cliente single, distinta responsabilidad (lectura batch de campos públicos). Construido como
 * provider local (mismo patrón que los demás clientes gRPC del módulo).
 */
const identityBatchClientProvider: Provider = {
  provide: IDENTITY_BATCH_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new GrpcIdentityBatchClient(
      config.getOrThrow<string>('IDENTITY_GRPC_URL'),
      config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
    ),
};

/**
 * Config de la BÚSQUEDA geo H3 (F2): k del anillo base + k expandido (si la base da 0). Desde env
 * (SEARCH_H3_K_RING / SEARCH_H3_K_RING_EXPAND), tunable sin redeploy. Objeto TIPADO (SearchH3Config).
 */
const searchH3ConfigProvider: Provider = {
  provide: SEARCH_H3_CONFIG,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): SearchH3Config => ({
    kRing: config.getOrThrow<number>('SEARCH_H3_K_RING'),
    kRingExpand: config.getOrThrow<number>('SEARCH_H3_K_RING_EXPAND'),
  }),
};

@Module({
  // BookingsModule exporta BookingsService (lo consume el handler GET /:id/bookings del controller, F3b).
  // CostPerKmConfigModule exporta CostPerKmConfigService (el costo/km DIRECTO del admin que alimenta el tope).
  imports: [MapsModule, BookingsModule, CostPerKmConfigModule],
  providers: [
    PublishedTripsService,
    PublishedTripsRepository,
    CostCapService,
    identityClientProvider,
    identityBatchClientProvider,
    fleetClientProvider,
    searchH3ConfigProvider,
  ],
  controllers: [PublishedTripsController],
  exports: [PublishedTripsService],
})
export class PublishedTripsModule {}
