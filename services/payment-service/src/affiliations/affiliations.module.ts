import { Module } from '@nestjs/common';
import { PaymentGatewayModule } from '../ports/gateway/payment-gateway.module';
import { AffiliationsService } from './affiliations.service';
import { AffiliationsController } from './affiliations.controller';

@Module({
  imports: [PaymentGatewayModule],
  providers: [AffiliationsService],
  controllers: [AffiliationsController],
  exports: [AffiliationsService],
})
export class AffiliationsModule {}
