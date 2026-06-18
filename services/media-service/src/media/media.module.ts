import { Module } from '@nestjs/common';
import { LiveKitModule } from '../ports/livekit/livekit.module';
import { StorageModule } from '../ports/storage/storage.module';
import { MediaController } from './media.controller';
import { AvatarController } from './avatar.controller';
import { InternalStorageController } from './internal-storage.controller';
import { RecordingService } from './recording.service';
import { AccessService } from './access.service';
import { AvatarService } from './avatar.service';
import { InternalStorageService } from './internal-storage.service';
import { RetentionSweeper } from './retention.sweeper';

@Module({
  imports: [LiveKitModule, StorageModule],
  controllers: [MediaController, AvatarController, InternalStorageController],
  providers: [
    RecordingService,
    AccessService,
    AvatarService,
    InternalStorageService,
    RetentionSweeper,
  ],
  exports: [RecordingService, AccessService, AvatarService],
})
export class MediaModule {}
