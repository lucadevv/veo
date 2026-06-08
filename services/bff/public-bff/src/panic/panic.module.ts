import { Module } from '@nestjs/common';
import { PanicService } from './panic.service';
import { PanicController } from './panic.controller';

@Module({
  controllers: [PanicController],
  providers: [PanicService],
})
export class PanicModule {}
