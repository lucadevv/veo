/**
 * SEGURIDAD — monitoreo y gestión de incidentes de pánico (RBAC seguridad/admin).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type { PanicSummary } from '@veo/api-client';
import { SecurityService, type PanicDetailView } from './security.service';
import { ListPanicsQueryDto, ResolvePanicDto, PanicEvidenceDto } from './dto/panic.dto';

@ApiTags('security')
@Controller('security')
@Roles(
  AdminRole.SUPPORT_L2,
  AdminRole.DISPATCHER,
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
)
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get('panics')
  @ApiOperation({ summary: 'Listado de incidentes de pánico (filtro por estado)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPanicsQueryDto): Promise<PanicSummary[]> {
    return this.security.listPanics(user, query);
  }

  @Get('panics/:id')
  @ApiOperation({ summary: 'Detalle de un incidente de pánico' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<PanicDetailView> {
    return this.security.getPanic(user, id);
  }

  @Post('panics/:id/ack')
  @HttpCode(200)
  @ApiOperation({ summary: 'Acusa recibo de un incidente (operador de seguridad)' })
  ack(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<PanicDetailView> {
    return this.security.ack(user, id);
  }

  @Post('panics/:id/resolve')
  @HttpCode(200)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Resuelve / marca falsa alarma (compliance/admin)' })
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResolvePanicDto,
  ): Promise<PanicDetailView> {
    return this.security.resolve(user, id, dto);
  }

  @Post('panics/:id/evidence')
  @HttpCode(200)
  @ApiOperation({ summary: 'Adjunta evidencia (claves S3) al incidente' })
  evidence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PanicEvidenceDto,
  ): Promise<{ evidenceS3Keys: string[]; protectedKeys: string[] }> {
    return this.security.addEvidence(user, id, dto);
  }
}
