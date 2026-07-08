import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { ExpirySweeper } from '../expirations/expiry.sweeper';
import { ExpirationsController } from '../expirations/expirations.controller';
import { InspectionsModule } from '../inspections/inspections.module';

@Module({
  imports: [InspectionsModule],
  providers: [DocumentsService, ExpirySweeper],
  controllers: [DocumentsController, ExpirationsController],
  exports: [DocumentsService, ExpirySweeper],
})
export class DocumentsModule {}
