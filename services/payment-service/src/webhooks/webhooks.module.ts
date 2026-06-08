import { Module } from '@nestjs/common';
import { PaymentGatewayModule } from '../ports/gateway/payment-gateway.module';
import { PaymentsModule } from '../payments/payments.module';
import { AffiliationsModule } from '../affiliations/affiliations.module';
import { ProntoPagaWebhookController } from './prontopaga-webhook.controller';
import { ProntoPagaWebhookService } from './prontopaga-webhook.service';

@Module({
  imports: [PaymentGatewayModule, PaymentsModule, AffiliationsModule],
  providers: [ProntoPagaWebhookService],
  controllers: [ProntoPagaWebhookController],
})
export class WebhooksModule {}
