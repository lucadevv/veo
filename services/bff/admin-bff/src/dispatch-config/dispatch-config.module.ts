import { Module } from '@nestjs/common';
import { DispatchConfigController } from './dispatch-config.controller';
import { DispatchConfigService } from './dispatch-config.service';

@Module({
  controllers: [DispatchConfigController],
  providers: [DispatchConfigService],
})
export class DispatchConfigModule {}
