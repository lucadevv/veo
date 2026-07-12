/**
 * SEGURIDAD — monitoreo y gestión de incidentes de pánico (RBAC seguridad/admin).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireStepUpMfa, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import type { PanicSummary, PanicDetail } from '@veo/api-client';
import { Permission } from '../policies/permission.decorator';
import { SecurityService } from './security.service';
import { ListPanicsQueryDto, ResolvePanicDto, PanicEvidenceDto } from './dto/panic.dto';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

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
  @Permission('panics:view')
  @ApiOperation({ summary: 'Listado de incidentes de pánico (filtro por estado)' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPanicsQueryDto,
  ): Promise<Page<PanicSummary>> {
    return this.security.listPanics(user, query);
  }

  @Get('panics/:id')
  @Permission('panics:view')
  @ApiOperation({ summary: 'Detalle de un incidente de pánico' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<PanicDetail> {
    return this.security.getPanic(user, id);
  }

  @Post('panics/:id/ack')
  @HttpCode(200)
  @Permission('panics:ack')
  @ApiOperation({ summary: 'Acusa recibo de un incidente (operador de seguridad)' })
  ack(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<PanicDetail> {
    return this.security.ack(user, id);
  }

  @Post('panics/:id/dispatch')
  @HttpCode(200)
  @Permission('panics:ack')
  @ApiOperation({ summary: 'Despacha una unidad de respuesta al incidente (acción lateral)' })
  dispatch(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<PanicDetail> {
    return this.security.dispatch(user, id);
  }

  @Post('panics/:id/escalate')
  @HttpCode(200)
  @Permission('panics:ack')
  @ApiOperation({ summary: 'Escala el incidente a autoridades (acción lateral)' })
  escalate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<PanicDetail> {
    return this.security.escalate(user, id);
  }

  @Post('panics/:id/resolve')
  @HttpCode(200)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Permission('panics:resolve')
  @RequireStepUpMfa()
  @ApiOperation({
    summary: 'Resuelve / marca falsa alarma (compliance/admin) — acción crítica, exige MFA fresca',
  })
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResolvePanicDto,
  ): Promise<PanicDetail> {
    return this.security.resolve(user, id, dto);
  }

  @Post('panics/:id/evidence')
  @HttpCode(200)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  // Front gatea el diálogo de evidencia con `can(panics:ack)` → mismo permiso para UI-oculta = server-bloquea.
  @Permission('panics:ack')
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'Adjunta evidencia (claves S3) al incidente — retención/object-lock IRREVERSIBLE (cadena de custodia Ley 29733), exige MFA fresca',
  })
  evidence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PanicEvidenceDto,
  ): Promise<{ evidenceS3Keys: string[]; protectedKeys: string[] }> {
    return this.security.addEvidence(user, id, dto);
  }
}
