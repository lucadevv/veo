import { Module } from '@nestjs/common';
import { ConsentsService } from './consents.service';
import { ConsentsRepository } from './consents.repository';
import { ConsentsController } from './consents.controller';

@Module({
  providers: [ConsentsService, ConsentsRepository],
  controllers: [ConsentsController],
  exports: [ConsentsService],
})
export class ConsentsModule {}
