/**
 * DISPATCH CONFIG — CRUD proxy de la config de RADIOS (k-rings) de dispatch hacia dispatch-service.
 * RBAC (defensa en profundidad): DISPATCHER es el rol operativo natural del despacho; ADMIN/SUPERADMIN
 * mantienen control. Gate a nivel de clase (lectura) + gate explícito del PUT (mutación).
 * El RolesGuard usa getAllAndOverride: el @Roles del método REEMPLAZA al de la clase (no une). Por eso el
 * PUT declara explícitamente su propio set. dispatch-service RE-valida: InternalIdentityGuard (firma) +
 * AdminIdentityGuard (type==='admin') en el PUT.
 */
import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { DispatchConfigService, type RadiusConfigView } from './dispatch-config.service';
import { ReplaceRadiusConfigDto } from './dto/dispatch-radius-config.dto';

@ApiTags('dispatch')
@Controller('admin/dispatch')
@Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.DISPATCHER)
export class DispatchConfigController {
  constructor(private readonly dispatch: DispatchConfigService) {}

  @Get('radius-config')
  @ApiOperation({ summary: 'Config de radios (k-rings) vigente (o el DEFAULT). ADMIN/SUPERADMIN/DISPATCHER.' })
  getRadiusConfig(@CurrentUser() user: AuthenticatedUser): Promise<RadiusConfigView> {
    return this.dispatch.getRadiusConfig(user);
  }

  @Put('radius-config')
  @HttpCode(200)
  @Roles(AdminRole.ADMIN, AdminRole.SUPERADMIN, AdminRole.DISPATCHER)
  @ApiOperation({
    summary: 'REEMPLAZA la config de radios (bump version) + emite el evento. ADMIN/SUPERADMIN/DISPATCHER.',
  })
  replaceRadiusConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceRadiusConfigDto,
  ): Promise<RadiusConfigView> {
    return this.dispatch.replaceRadiusConfig(user, dto);
  }
}
