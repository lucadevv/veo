import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { ShareService, type CreatedShareLink } from './share.service';
import { CreateShareLinkDto } from './dto/share.dto';

@ApiTags('share')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
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
    return this.share.createLink(user.userId, tripId, dto);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revocar un enlace de seguimiento' })
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ revokedAt: string }> {
    return this.share.revoke(user.userId, id);
  }
}
