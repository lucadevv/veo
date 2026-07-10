import { Module } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { PayoutsRepository } from './payouts.repository';
import { PayoutsController } from './payouts.controller';
import { PayoutPollService } from './payout-poll.service';
import { PayoutPollRepository } from './payout-poll.repository';
import { PayoutGatewayModule } from '../ports/gateway/payout-gateway.module';

@Module({
  // PayoutGatewayModule expone el puerto money-OUT (PAYOUT_GATEWAY) para que el dominio del payout lo
  // inyecte (sub-lote 2b: el carril de desembolso + el poll fallback de confirmación).
  imports: [PayoutGatewayModule],
  // PayoutPollService cierra el ciclo async del desembolso (PROCESSING→PROCESSED|FAILED) por poll fallback
  // cuando el webhook del riel no llega (dev sin túnel) — espejo del PaymentPollService del money-IN.
  providers: [PayoutsService, PayoutsRepository, PayoutPollService, PayoutPollRepository],
  controllers: [PayoutsController],
  exports: [PayoutsService],
})
export class PayoutsModule {}
