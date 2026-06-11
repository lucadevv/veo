import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { IncentivesModule } from '../incentives/incentives.module';
import { AffiliationsModule } from '../affiliations/affiliations.module';
import { PaymentEventConsumers } from './consumers';
import { UserDeletedConsumer } from './user-deleted.consumer';

@Module({
  imports: [PaymentsModule, PayoutsModule, IncentivesModule, AffiliationsModule],
  providers: [PaymentEventConsumers, UserDeletedConsumer],
})
export class EventsModule {}
