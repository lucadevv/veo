import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { DeviceTokenRepository } from './device-token.repository';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService, DeviceTokenRepository],
  exports: [DeviceTokenRepository],
})
export class DevicesModule {}
