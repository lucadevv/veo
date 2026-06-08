/**
 * Media del conductor. JWT de tipo 'driver'. Emite el token de publicación de la cámara para el
 * viaje indicado, proxeando al media-service con identidad interna firmada.
 */
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DriverApi } from '../common/driver-api.decorator';
import { MediaService } from './media.service';
import { IssuePublisherTokenDto, type PublisherGrant } from './dto/media.dto';

@ApiTags('media')
@DriverApi()
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('rooms/:tripId/publisher-token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Emitir token LiveKit de publicación de cámara del conductor (BR-S01)' })
  issuePublisherToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') tripId: string,
    @Body() dto: IssuePublisherTokenDto,
  ): Promise<PublisherGrant> {
    return this.media.issuePublisherToken(user, tripId, dto.name);
  }
}
