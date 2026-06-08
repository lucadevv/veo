import { Module } from '@nestjs/common';
import { IncentivesController } from './incentives.controller';
import { IncentivesService } from './incentives.service';

@Module({
  controllers: [IncentivesController],
  providers: [IncentivesService],
})
export class IncentivesModule {}
