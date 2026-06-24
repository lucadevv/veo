import { Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { ErasureConsumer } from './erasure.consumer';

/**
 * Consumers Kafka de fleet-service. Hoy: ErasureConsumer (derecho al olvido, `user.deleted`).
 * Importa VehiclesModule para inyectar VehiclesService (la lógica de purga). REDIS + ConfigService
 * vienen del CoreModule @Global / ConfigModule global.
 */
@Module({
  imports: [VehiclesModule],
  providers: [ErasureConsumer],
})
export class EventsModule {}
