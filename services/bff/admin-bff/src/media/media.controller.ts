/**
 * VIDEO (doble-auth) — solicitud de acceso, decisión (approve con step-up MFA / reject solo-rol),
 * stream firmado (step-up MFA), listado de segmentos y token de cámara EN VIVO.
 * RBAC: compliance/admin a nivel CLASE (request/reject/stream/list). approve OVERRIDE a nivel método a
 * COMPLIANCE_SUPERVISOR+SUPERADMIN (ADMIN solicita pero NO aprueba). approve y stream exigen
 * @RequireStepUpMfa() (StepUpMfaGuard).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import {
  MediaService,
  type LiveViewerToken,
  type MediaAccessRequestView,
  type SegmentView,
  type SignedMedia,
} from './media.service';
import {
  AccessRequestsQueryDto,
  LiveAccessDto,
  RequestAccessDto,
  SegmentsQueryDto,
} from './dto/media.dto';

/** Página con cursor; misma forma que `paginated()` del contrato admin-web. */
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@ApiTags('media')
@Controller('media')
@Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('access-requests')
  @ApiOperation({ summary: 'Lista las solicitudes de acceso a video (opcional por estado)' })
  async listRequests(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AccessRequestsQueryDto,
  ): Promise<Page<MediaAccessRequestView>> {
    // media-service devuelve un array; el contrato admin es paginado. Sin cursor downstream → nextCursor null.
    const items = await this.media.listRequests(user, query.status);
    return { items, nextCursor: null };
  }

  @Post('access-requests')
  @ApiOperation({ summary: 'Solicita acceso a video de un viaje (queda PENDING)' })
  requestAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestAccessDto,
  ): Promise<MediaAccessRequestView> {
    return this.media.requestAccess(user, dto);
  }

  // Separación de funciones (decisión del dueño): AUTORIZAR el acceso a video grabado (dato sensible,
  // Ley 29733) es función de CUMPLIMIENTO. Este @Roles a NIVEL MÉTODO OVERRIDE el set amplio de la clase
  // (RolesGuard.getAllAndOverride: método > clase): ADMIN puede SOLICITAR/VER pero NO APROBAR. Espeja la
  // segregación de auditoría (audit:*). Complementa el four-eyes por IDENTIDAD del media-service.
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.SUPERADMIN)
  @Post('access-requests/:id/approve')
  @HttpCode(200)
  @RequireStepUpMfa()
  @ApiOperation({ summary: 'Aprueba el acceso (COMPLIANCE/SUPERADMIN + MFA fresca)' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<MediaAccessRequestView> {
    return this.media.approveRequest(user, id);
  }

  // reject NO override el @Roles de clase (queda el set amplio incl. ADMIN) A PROPÓSITO: RECHAZAR deniega
  // acceso (dirección SEGURA — no otorga dato sensible), así que no exige la restricción de cumplimiento que
  // sí exige approve. Solo-rol, sin step-up. La sensibilidad está en OTORGAR (approve), no en denegar.
  @Post('access-requests/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechaza el acceso (solo rol, sin step-up)' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<MediaAccessRequestView> {
    return this.media.rejectRequest(user, id);
  }

  @Get('access-requests/:id/stream')
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'URL firmada del video aprobado (requiere MFA fresca); incluye watermark',
  })
  stream(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<SignedMedia> {
    return this.media.streamRequest(user, id);
  }

  @Post('live/token')
  @HttpCode(200)
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'Token de cámara EN VIVO de un viaje (muro admin; doble-auth: rol + MFA fresca)',
  })
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
