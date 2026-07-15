import { Module } from '@nestjs/common';
import { BiometricModule } from '../ports/biometric/biometric.module';
import { KycService } from './kyc.service';
import { KycRepository } from './kyc.repository';
import { KycController } from './kyc.controller';

@Module({
  imports: [BiometricModule],
  providers: [KycService, KycRepository],
  controllers: [KycController],
  exports: [KycService],
})
export class KycModule {}
