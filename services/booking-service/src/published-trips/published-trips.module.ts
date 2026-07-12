/**
 * PublishedTripsModule — el ciclo lado-conductor de la oferta de carpooling (publicar/editar/cancelar/
 * listar) + la BÚSQUEDA geo. Cablea los clientes gRPC SALIENTES de los gates F1a (identity + fleet) como
 * providers locales del módulo (mismo patrón que dispatch-service): cada uno se construye con su URL del
 * ConfigService + el INTERNAL_IDENTITY_SECRET (provisto global por CoreModule). El servicio depende de los
 * PUERTOS (IDENTITY_CLIENT/FLEET_CLIENT), no de las clases gRPC — en tests se inyecta un fake del mismo contrato.
 *
 * F2 — RADIO EDITABLE POR EL ADMIN: importa CarpoolSearchConfigModule y cablea el reader del radio
 * (SEARCH_RADIUS_READER → CarpoolSearchConfigService) que PublishedTripsService consume en runtime (búsqueda +
 * radar). El controller interno admin (GET/PUT config + radar-preview) se monta ACÁ (no en el módulo de config)
 * porque el radar-preview reusa PublishedTripsService — así ambos deps conviven sin ciclo de módulos.
 */
import { Module } from '@nestjs/common';
import { PublishedTripsService } from './published-trips.service';
import { PublishedTripsRepository } from './published-trips.repository';
import { PublishedTripsController } from './published-trips.controller';
import { CostCapModule } from '../cost-cap/cost-cap.module';
import { BookingsModule } from '../bookings/bookings.module';
import { IdentityModule } from '../identity/identity.module';
import { FleetModule } from '../fleet/fleet.module';
import { CarpoolSearchConfigModule } from '../search-radius/carpool-search-config.module';
import {
  CarpoolSearchConfigService,
  SEARCH_RADIUS_READER,
} from '../search-radius/carpool-search-config.service';
import { SearchRadiusController } from '../search-radius/search-radius.controller';
import { AdminIdentityGuard } from '../search-radius/admin-identity.guard';

@Module({
  // BookingsModule exporta BookingsService (lo consume el handler GET /:id/bookings del controller, F3b).
  // CostCapModule exporta CostCapService (el gate F1b del tope de cost-sharing; ahora módulo propio para que
  // BookingsModule también lo consuma sin cerrar un ciclo published-trips ↔ bookings).
  // IdentityModule provee IDENTITY_CLIENT + IDENTITY_BATCH_CLIENT (gates del conductor en publish + búsqueda).
  // FleetModule provee FLEET_CLIENT. Ambos son proveedores ÚNICOS (antes duplicados inline en cada módulo).
  // CarpoolSearchConfigModule exporta CarpoolSearchConfigService (radio de búsqueda editable en runtime).
  imports: [CostCapModule, BookingsModule, FleetModule, IdentityModule, CarpoolSearchConfigModule],
  providers: [
    PublishedTripsService,
    PublishedTripsRepository,
    // El reader del radio (búsqueda + radar) inyecta la MISMA instancia del CarpoolSearchConfigService (que
    // el controller GET/PUT también usa) → un solo cache in-proc: el PUT invalida y la búsqueda lo ve al toque.
    { provide: SEARCH_RADIUS_READER, useExisting: CarpoolSearchConfigService },
    AdminIdentityGuard,
  ],
  controllers: [PublishedTripsController, SearchRadiusController],
  exports: [PublishedTripsService],
})
export class PublishedTripsModule {}
