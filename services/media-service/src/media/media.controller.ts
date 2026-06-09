import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  InternalIdentityGuard,
  RequireStepUpMfa,
  Roles,
  RolesGuard,
  StepUpMfaGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { RecordingService } from './recording.service';
import { AccessService } from './access.service';
import { CreateAccessRequestDto, IssueRoomTokenDto, ListSegmentsQueryDto } from './dto/media.dto';

interface SegmentView {
  id: string;
  tripId: string;
  startedAt: string;
  endedAt: string | null;
  sizeBytes: number;
  codec: string;
  retentionUntil: string | null;
  accessedCount: number;
  hasPanic: boolean;
  hasIncident: boolean;
}

@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
export class MediaController {
  constructor(
    private readonly recording: RecordingService,
    private readonly access: AccessService,
  ) {}

  /** BR-S01: emite un token LiveKit de cámara al passenger/driver del viaje. */
  @UseGuards(InternalIdentityGuard)
  @Post('rooms/:tripId/token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Emitir token LiveKit de cámara para la room del viaje (BR-S01)' })
  issueToken(
    @Param('tripId') tripId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: IssueRoomTokenDto,
  ): Promise<{ roomName: string; token: string; url: string; expiresInSeconds: number }> {
    return this.recording.issueRoomToken({ tripId, identity: user.userId, name: dto.name });
  }

  /**
   * Muro de cámaras EN VIVO (admin): token LiveKit SOLO-SUSCRIPCIÓN de la cabina de un viaje en curso.
   * Doble-auth como las grabaciones: @Roles (compliance/admin) + StepUpMfaGuard (MFA fresca). El admin-bff
   * re-gatea y AUDITA con el motivo. Es espectador puro (canPublish/Data:false en issueViewerToken).
   */
  @UseGuards(InternalIdentityGuard, RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @RequireStepUpMfa()
  @Post('rooms/:tripId/viewer-token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Token LiveKit solo-suscripción de la cabina en vivo (admin, doble-auth)' })
  issueViewerToken(
    @Param('tripId') tripId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: IssueRoomTokenDto,
  ): Promise<{ roomName: string; token: string; url: string; expiresInSeconds: number }> {
    return this.recording.issueViewerToken({ tripId, identity: user.userId, name: dto.name });
  }

  /** BR-S02 (paso 1): un operador solicita acceso a video con un motivo (> 20 chars). */
  @UseGuards(InternalIdentityGuard)
  @Post('access')
  @ApiOperation({ summary: 'Solicitar acceso a video (requiere aprobación posterior) (BR-S02)' })
  requestAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAccessRequestDto,
  ): Promise<{ id: string; status: 'PENDING' }> {
    return this.access.requestAccess({
      tripId: dto.tripId,
      segmentId: dto.segmentId,
      requestedBy: user.userId,
      requestedByEmail: dto.operatorEmail,
      reason: dto.reason,
    });
  }

  /** BR-S02 (paso 2): COMPLIANCE_SUPERVISOR con MFA fresca aprueba → URL firmada (5 min) + watermark. */
  @UseGuards(InternalIdentityGuard, RolesGuard, StepUpMfaGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR)
  @RequireStepUpMfa()
  @Post('access/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aprobar acceso a video (COMPLIANCE + MFA) → signed URL + watermark (BR-S02)' })
  approve(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ requestId: string; signedUrl: string; watermark: string; expiresAt: Date; segmentId: string }> {
    return this.access.approveAccess(id, user.userId);
  }

  /** Lista los metadatos de los segmentos de un viaje (solo cumplimiento; nunca URLs). */
  @UseGuards(InternalIdentityGuard, RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR)
  @Get('segments')
  @ApiOperation({ summary: 'Listar segmentos de video de un viaje (metadatos) (BR-S02)' })
  async listSegments(@Query() query: ListSegmentsQueryDto): Promise<SegmentView[]> {
    const segments = await this.access.listSegments(query.tripId);
    return segments.map((s) => ({
      id: s.id,
      tripId: s.tripId,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      sizeBytes: Number(s.sizeBytes),
      codec: s.codec,
      retentionUntil: s.retentionUntil?.toISOString() ?? null,
      accessedCount: s.accessedCount,
      hasPanic: s.hasPanic,
      hasIncident: s.hasIncident,
    }));
  }
}
