import { Module } from '@nestjs/common';
import { PaymentGatewayModule } from '../ports/gateway/payment-gateway.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationRepository } from './reconciliation.repository';
import { ReconciliationController } from './reconciliation.controller';
import { PaymentPollService } from './payment-poll.service';

@Module({
  // PaymentsModule aporta PaymentsService (applyWebhookResult) para el poll fallback.
  imports: [PaymentGatewayModule, PaymentsModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ReconciliationRepository, PaymentPollService],
  exports: [ReconciliationService, PaymentPollService],
})
export class ReconciliationModule {}
