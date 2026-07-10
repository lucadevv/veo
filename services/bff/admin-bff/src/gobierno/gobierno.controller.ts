/**
 * GOBIERNO — Políticas de gobierno (PBAC · ADR-024 §6). El BORDE de autoridad del registro de políticas:
 * el admin-bff aplica RBAC(SUPERADMIN) + step-up MFA y reenvía a identity-service (el STORAGE) por REST
 * interno firmado (audiencia admin-rail). "Todo el gobierno es solo-superadmin" (diseño AdminPoliticas) →
 * @Roles(SUPERADMIN) a nivel de CLASE: las lecturas (grilla/detalle) y la escritura lo heredan. El PUT
 * (mutar una política) suma @RequireStepUpMfa() — cambiar un candado de seguridad/compliance es la acción
 * sensible por excelencia. Las lecturas NO exigen step-up.
 *
 * identity RE-valida en profundidad (InternalIdentityGuard + AudienceGuard(ADMIN_RAIL) + validación Zod de
 * params + candado `mandatory`): defensa en profundidad. El BFF autoriza y reenvía; no re-implementa el schema.
 */
import { Body, Controller, Get, HttpCode, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireStepUpMfa, Roles, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { GobiernoService, type PolicyView } from './gobierno.service';
import { UpdatePolicyDto } from './dto/update-policy.dto';

@ApiTags('gobierno')
@Controller('gobierno')
// Todo Gobierno → Políticas es EXCLUSIVO de SUPERADMIN (el borde de autoridad · diseño "Solo superadmin").
// El RolesGuard usa getAllAndOverride: sin @Roles de método, los handlers heredan este set de clase.
@Roles(AdminRole.SUPERADMIN)
export class GobiernoController {
  constructor(private readonly gobierno: GobiernoService) {}

  @Get('policies')
  @ApiOperation({ summary: 'Lista todas las políticas de gobierno vigentes (la grilla). Solo SUPERADMIN.' })
  listPolicies(@CurrentUser() user: AuthenticatedUser): Promise<PolicyView[]> {
    return this.gobierno.list(user);
  }

  @Get('policies/:key')
  @ApiOperation({ summary: 'Una política de gobierno por su key. Solo SUPERADMIN.' })
  getPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
  ): Promise<PolicyView> {
    return this.gobierno.get(user, key);
  }

  @Put('policies/:key')
  @HttpCode(200)
  @RequireStepUpMfa()
  @ApiOperation({
    summary:
      'Aplica {enabled?, params?} a una política: reenvía a identity (valida params, candado mandatory, ' +
      'bump version + policy.updated). Solo SUPERADMIN + step-up MFA.',
  })
  updatePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Body() dto: UpdatePolicyDto,
  ): Promise<PolicyView> {
    return this.gobierno.update(user, key, dto);
  }
}
