import { Module } from '@nestjs/common';
import { CarpoolController } from './carpool.controller';
import { CarpoolService } from './carpool.service';

@Module({
  controllers: [CarpoolController],
  providers: [CarpoolService],
})
export class CarpoolModule {}
