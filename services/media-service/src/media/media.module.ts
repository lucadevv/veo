import { Module } from '@nestjs/common';
import { LiveKitModule } from '../ports/livekit/livekit.module';
import { StorageModule } from '../ports/storage/storage.module';
import { WatermarkModule } from '../ports/watermark/watermark.module';
import { MediaController } from './media.controller';
import { AvatarController } from './avatar.controller';
import { InternalStorageController } from './internal-storage.controller';
import { RecordingService } from './recording.service';
import { AccessService } from './access.service';
import { AvatarService } from './avatar.service';
import { InternalStorageService } from './internal-storage.service';
import { RetentionSweeper } from './retention.sweeper';
import { VideoRenderWorker } from './video-render.worker';

@Module({
  imports: [LiveKitModule, StorageModule, WatermarkModule],
  controllers: [MediaController, AvatarController, InternalStorageController],
  providers: [
    RecordingService,
    AccessService,
    AvatarService,
    InternalStorageService,
    RetentionSweeper,
    VideoRenderWorker,
  ],
  exports: [RecordingService, AccessService, AvatarService],
})
export class MediaModule {}
