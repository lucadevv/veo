import { Module } from '@nestjs/common';
import { PaymentGatewayModule } from '../ports/gateway/payment-gateway.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { AffiliationsModule } from '../affiliations/affiliations.module';
import { CreditModule } from '../credit/credit.module';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [PaymentGatewayModule, PromotionsModule, AffiliationsModule, CreditModule],
  providers: [PaymentsService],
  controllers: [PaymentsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
