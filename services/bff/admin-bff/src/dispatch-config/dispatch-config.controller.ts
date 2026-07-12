/**
 * DISPATCH CONFIG — CRUD proxy de la config de RADIOS (k-rings + política v2) de dispatch hacia dispatch-service
 * y del radio de búsqueda del CARPOOLING hacia booking-service.
 * RBAC (defensa en profundidad): DISPATCHER es el rol operativo natural del despacho; ADMIN/SUPERADMIN
 * mantienen control. Gate a nivel de clase (lectura) + gate explícito de cada PUT (mutación).
 * El RolesGuard usa getAllAndOverride: el @Roles del método REEMPLAZA al de la clase (no une). Por eso el
 * PUT declara explícitamente su propio set. Cada servicio RE-valida: InternalIdentityGuard (firma) +
 * AdminIdentityGuard (type==='admin') en el PUT.
 */
import { Body, Controller, Get, HttpCode, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, RequireStepUpMfa, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import {
  DispatchConfigService,
  type RadiusConfigView,
  type CarpoolSearchConfigView,
  type RadarPreviewView,
} from './dispatch-config.service';
import {
  ReplaceRadiusConfigDto,
  ReplaceCarpoolConfigDto,
  DispatchRadarQueryDto,
  CarpoolRadarQueryDto,
} from './dto/dispatch-radius-config.dto';
import { Permission } from '../policies/permission.decorator';

@ApiTags('dispatch')
// Prefijo PELADO (no 'admin/dispatch'): el admin-bff ya es admin-scoped y TODOS sus controllers usan el
// nombre del recurso a secas (fleet/ops/finance/...). El cliente llama '/dispatch/radius-config'; el prefijo
// 'admin/' era el único outlier y causaba 404 (Cannot GET /api/v1/dispatch/radius-config).
@Controller('dispatch')
@Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.DISPATCHER)
export class DispatchConfigController {
  constructor(private readonly dispatch: DispatchConfigService) {}

  @Get('radius-config')
  @Permission('dispatch:view')
  @ApiOperation({
    summary: 'Config de radios (k-rings + política v2) vigente (o el DEFAULT). ADMIN/SUPERADMIN/DISPATCHER.',
  })
  getRadiusConfig(@CurrentUser() user: AuthenticatedUser): Promise<RadiusConfigView> {
    return this.dispatch.getRadiusConfig(user);
  }

  @Put('radius-config')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.DISPATCHER)
  @Permission('dispatch:manage')
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'REEMPLAZA la config de radios (k-rings + política v2, bump version) + emite el evento. ADMIN/SUPERADMIN/DISPATCHER.',
  })
  replaceRadiusConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceRadiusConfigDto,
  ): Promise<RadiusConfigView> {
    return this.dispatch.replaceRadiusConfig(user, dto);
  }

  @Get('radar-preview')
  @Permission('dispatch:view')
  @ApiOperation({
    summary: 'Radar de cobertura (anillos) de dispatch para un punto. ADMIN/SUPERADMIN/DISPATCHER.',
  })
  radarPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DispatchRadarQueryDto,
  ): Promise<RadarPreviewView> {
    return this.dispatch.radarPreview(user, query.mode, query.lat, query.lon);
  }

  @Get('carpool-radius-config')
  @Permission('dispatch:view')
  @ApiOperation({
    summary: 'Radio de búsqueda del carpooling vigente (booking-service). ADMIN/SUPERADMIN/DISPATCHER.',
  })
  getCarpoolConfig(@CurrentUser() user: AuthenticatedUser): Promise<CarpoolSearchConfigView> {
    return this.dispatch.getCarpoolConfig(user);
  }

  @Put('carpool-radius-config')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.DISPATCHER)
  @Permission('dispatch:manage')
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'REEMPLAZA el radio de búsqueda del carpooling (bump version) en booking-service. ADMIN/SUPERADMIN/DISPATCHER.',
  })
  replaceCarpoolConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceCarpoolConfigDto,
  ): Promise<CarpoolSearchConfigView> {
    return this.dispatch.replaceCarpoolConfig(user, dto);
  }

  @Get('carpool-radar-preview')
  @Permission('dispatch:view')
  @ApiOperation({
    summary: 'Radar de cobertura (anillos) del carpooling para un punto. ADMIN/SUPERADMIN/DISPATCHER.',
  })
  carpoolRadar(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CarpoolRadarQueryDto,
  ): Promise<RadarPreviewView> {
    return this.dispatch.carpoolRadar(user, query.lat, query.lon);
  }
}
