import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { ShareService } from './share.service';
import { CreateShareLinkDto } from './dto/share.dto';
import { type CreatedShareLink } from './share.types';

@ApiTags('share')
@ApiBearerAuth()
@Controller('share')
export class ShareController {
  constructor(private readonly share: ShareService) {}

  @Post(':tripId')
  @ApiOperation({ summary: 'Crear enlace de seguimiento firmado para un viaje (BR-S05)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId') tripId: string,
    @Body() dto: CreateShareLinkDto,
  ): Promise<CreatedShareLink> {
    return this.share.createLink(user, tripId, dto);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revocar un enlace de seguimiento (corta sesiones en vivo)' })
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ revokedAt: string }> {
    return this.share.revoke(user, id);
  }
}
