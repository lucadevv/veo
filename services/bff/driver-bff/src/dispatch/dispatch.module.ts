import { Module } from '@nestjs/common';
import { DispatchController } from './dispatch.controller';
import { BidsController } from './bids.controller';
import { DispatchService } from './dispatch.service';

@Module({
  controllers: [DispatchController, BidsController],
  providers: [DispatchService],
})
export class DispatchModule {}
