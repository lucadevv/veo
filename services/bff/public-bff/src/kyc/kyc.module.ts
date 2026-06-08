import { Module } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';

@Module({
  controllers: [KycController],
  providers: [KycService],
})
export class KycModule {}
