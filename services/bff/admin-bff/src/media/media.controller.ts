/**
 * VIDEO (doble-auth) — solicitud de acceso, aprobación con step-up MFA, y listado de segmentos.
 * RBAC: compliance/admin. La aprobación exige @RequireStepUpMfa() (StepUpMfaGuard).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { MediaService, type ApprovedAccess, type LiveViewerToken, type SegmentView } from './media.service';
import { LiveAccessDto, RequestAccessDto, SegmentsQueryDto } from './dto/media.dto';

@ApiTags('media')
@Controller('media')
@Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('access')
  @ApiOperation({ summary: 'Solicita acceso a video de un viaje (queda PENDING)' })
  requestAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestAccessDto,
  ): Promise<{ id: string; status: string }> {
    return this.media.requestAccess(user, dto);
  }

  @Post('access/:id/approve')
  @HttpCode(200)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Aprueba el acceso (requiere MFA fresca); devuelve URL firmada + watermark' })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<ApprovedAccess> {
    return this.media.approveAccess(user, id);
  }

  @Post('live/token')
  @HttpCode(200)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Token de cámara EN VIVO de un viaje (muro admin; doble-auth: rol + MFA fresca)' })
  liveToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: LiveAccessDto,
  ): Promise<LiveViewerToken> {
    return this.media.issueLiveToken(user, dto);
  }

  @Get('segments')
  @ApiOperation({ summary: 'Segmentos de video de un viaje' })
  segments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SegmentsQueryDto,
  ): Promise<SegmentView[]> {
    return this.media.segments(user, query.tripId);
  }
}
