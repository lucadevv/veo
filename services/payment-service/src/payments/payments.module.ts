import { Module } from '@nestjs/common';
import { PaymentGatewayModule } from '../ports/gateway/payment-gateway.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { AffiliationsModule } from '../affiliations/affiliations.module';
import { CreditModule } from '../credit/credit.module';
import { CommissionModule } from '../commission/commission.module';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';
import { PaymentsController } from './payments.controller';
import { RefundsController } from './refunds.controller';

@Module({
  imports: [
    PaymentGatewayModule,
    PromotionsModule,
    AffiliationsModule,
    CreditModule,
    CommissionModule,
  ],
  providers: [PaymentsService, PaymentsRepository],
  controllers: [PaymentsController, RefundsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
