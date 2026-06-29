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
import { CostCapModule } from '../cost-cap/cost-cap.module';
import { BookingsModule } from '../bookings/bookings.module';
import { IdentityModule } from '../identity/identity.module';
import { FleetModule } from '../fleet/fleet.module';
import type { Env } from '../config/env.schema';

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
  // CostCapModule exporta CostCapService (el gate F1b del tope de cost-sharing; ahora módulo propio para que
  // BookingsModule también lo consuma sin cerrar un ciclo published-trips ↔ bookings).
  // IdentityModule provee IDENTITY_CLIENT + IDENTITY_BATCH_CLIENT (gates del conductor en publish + búsqueda).
  // FleetModule provee FLEET_CLIENT. Ambos son proveedores ÚNICOS (antes duplicados inline en cada módulo).
  imports: [CostCapModule, BookingsModule, FleetModule, IdentityModule],
  providers: [PublishedTripsService, PublishedTripsRepository, searchH3ConfigProvider],
  controllers: [PublishedTripsController],
  exports: [PublishedTripsService],
})
export class PublishedTripsModule {}
