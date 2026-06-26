import { Module } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { PayoutsController } from './payouts.controller';
import { PayoutGatewayModule } from '../ports/gateway/payout-gateway.module';

@Module({
  // PayoutGatewayModule expone el puerto money-OUT (PAYOUT_GATEWAY) para que el dominio del payout lo
  // inyecte (sub-lote 2b). Additive: importarlo NO cambia el comportamiento actual del cron.
  imports: [PayoutGatewayModule],
  providers: [PayoutsService],
  controllers: [PayoutsController],
  exports: [PayoutsService],
})
export class PayoutsModule {}
