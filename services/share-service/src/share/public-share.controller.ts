import { Controller, Get, Ip, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '@veo/auth';
import { ShareService, type FamilyTrackingView } from './share.service';

@ApiTags('public-share')
@Controller('public/share')
export class PublicShareController {
  constructor(private readonly share: ShareService) {}

  @Public()
  @Get(':token')
  @ApiOperation({
    summary: 'Página familia: seguimiento del viaje vía enlace firmado (PÚBLICO, sin login)',
  })
  view(@Param('token') token: string, @Ip() ip: string): Promise<FamilyTrackingView> {
    return this.share.publicView(token, ip ?? null);
  }
}
