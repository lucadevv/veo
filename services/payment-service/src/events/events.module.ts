import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { IncentivesModule } from '../incentives/incentives.module';
import { PaymentEventConsumers } from './consumers';

@Module({
  imports: [PaymentsModule, PayoutsModule, IncentivesModule],
  providers: [PaymentEventConsumers],
})
export class EventsModule {}
