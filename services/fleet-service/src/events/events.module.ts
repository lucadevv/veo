import { Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { ErasureConsumer } from './erasure.consumer';
import { CatalogOperabilityConsumer } from './catalog-operability.consumer';
import { CatalogOperabilityService } from './catalog-operability.service';

/**
 * Consumers Kafka de fleet-service:
 *  - ErasureConsumer (derecho al olvido, `user.deleted`).
 *  - CatalogOperabilityConsumer (seam catálogo↔operabilidad, `catalog.updated`): suspende/reincorpora a los
 *    conductores según qué CLASE de vehículo el admin apaga/enciende en el catálogo (ADR 013).
 * Importa VehiclesModule para inyectar VehiclesService (la purga de erasure). PrismaService + REDIS +
 * ConfigService vienen del CoreModule @Global / ConfigModule global.
 */
@Module({
  imports: [VehiclesModule],
  providers: [ErasureConsumer, CatalogOperabilityConsumer, CatalogOperabilityService],
})
export class EventsModule {}
