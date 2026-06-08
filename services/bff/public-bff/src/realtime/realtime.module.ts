import { Module } from '@nestjs/common';
import { RealtimeStateService } from './realtime-state.service';
import { FamilyGateway } from './family.gateway';
import { PassengerGateway } from './passenger.gateway';
import { RealtimeConsumerService } from './realtime-consumer.service';

/**
 * Tiempo real: gateways Socket.IO /family (link de share) y /passenger (pasajero autenticado) +
 * consumidor Kafka que alimenta a ambos. Exporta el estado y el gateway de familia para que el
 * módulo de share lea la ubicación en vivo y dispare la revocación dirigida.
 */
@Module({
  providers: [RealtimeStateService, FamilyGateway, PassengerGateway, RealtimeConsumerService],
  exports: [RealtimeStateService, FamilyGateway],
})
export class RealtimeModule {}
