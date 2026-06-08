/**
 * RealtimeModule (global): read-model CQRS + gateway Socket.IO /ops + consumidor Kafka que los alimenta.
 * Global porque ReadModelService lo consume el módulo OPS para servir los listados.
 */
import { Global, Module } from '@nestjs/common';
import { ReadModelService } from '../read-model/read-model.service';
import { OpsGateway } from '../gateway/ops.gateway';
import { WsTicketService } from '../gateway/ws-ticket.service';
import { KafkaConsumerService } from '../events/kafka-consumer.service';

@Global()
@Module({
  providers: [ReadModelService, OpsGateway, WsTicketService, KafkaConsumerService],
  // WsTicketService se exporta para que AuthController (AuthModule) pueda acuñar tickets.
  exports: [ReadModelService, OpsGateway, WsTicketService],
})
export class RealtimeModule {}
