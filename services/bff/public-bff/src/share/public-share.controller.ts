import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@veo/auth';
import type { FamilyTrackingView, FamilyVideoGrant } from '@veo/api-client';
import { ShareService } from './share.service';

@ApiTags('public-share')
@Controller('public/share')
export class PublicShareController {
  constructor(private readonly share: ShareService) {}

  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'Vista pública de seguimiento familiar (sin login)' })
  view(@Param('token') token: string): Promise<FamilyTrackingView> {
    return this.share.publicView(token);
  }

  @Public()
  @Get(':token/video')
  @ApiOperation({
    summary: 'Autorización de video del habitáculo (LiveKit) para el enlace familiar',
  })
  video(@Param('token') token: string): Promise<FamilyVideoGrant> {
    return this.share.videoGrant(token);
  }
}
