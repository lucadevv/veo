import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { ShareService } from './share.service';
import { ShareController } from './share.controller';
import { PublicShareController } from './public-share.controller';

@Module({
  imports: [RealtimeModule],
  controllers: [ShareController, PublicShareController],
  providers: [ShareService],
})
export class ShareModule {}
