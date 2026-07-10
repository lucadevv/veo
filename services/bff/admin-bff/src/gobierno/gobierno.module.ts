import { Module } from '@nestjs/common';
import { GobiernoController } from './gobierno.controller';
import { GobiernoService } from './gobierno.service';

@Module({
  controllers: [GobiernoController],
  providers: [GobiernoService],
})
export class GobiernoModule {}
