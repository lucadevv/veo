import { Module } from '@nestjs/common';
import { PaymentGatewayModule } from '../ports/gateway/payment-gateway.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReconciliationService } from './reconciliation.service';
import { PaymentPollService } from './payment-poll.service';

@Module({
  // PaymentsModule aporta PaymentsService (applyWebhookResult) para el poll fallback.
  imports: [PaymentGatewayModule, PaymentsModule],
  providers: [ReconciliationService, PaymentPollService],
  exports: [ReconciliationService, PaymentPollService],
})
export class ReconciliationModule {}
