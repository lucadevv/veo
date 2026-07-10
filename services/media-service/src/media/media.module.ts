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
import { MEDIA_REPO, PrismaMediaRepository } from './media.repository';

@Module({
  imports: [LiveKitModule, StorageModule, WatermarkModule],
  controllers: [MediaController, AvatarController, InternalStorageController],
  providers: [
    { provide: MEDIA_REPO, useClass: PrismaMediaRepository },
    RecordingService,
    AccessService,
    AvatarService,
    InternalStorageService,
    RetentionSweeper,
    VideoRenderWorker,
  ],
  // MEDIA_REPO se exporta porque MediaGrpcController (declarado en AppModule) lo inyecta.
  exports: [RecordingService, AccessService, AvatarService, MEDIA_REPO],
})
export class MediaModule {}
