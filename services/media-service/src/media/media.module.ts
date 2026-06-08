import { Module } from '@nestjs/common';
import { LiveKitModule } from '../ports/livekit/livekit.module';
import { StorageModule } from '../ports/storage/storage.module';
import { MediaController } from './media.controller';
import { AvatarController } from './avatar.controller';
import { RecordingService } from './recording.service';
import { AccessService } from './access.service';
import { AvatarService } from './avatar.service';
import { RetentionSweeper } from './retention.sweeper';

@Module({
  imports: [LiveKitModule, StorageModule],
  controllers: [MediaController, AvatarController],
  providers: [RecordingService, AccessService, AvatarService, RetentionSweeper],
  exports: [RecordingService, AccessService, AvatarService],
})
export class MediaModule {}
