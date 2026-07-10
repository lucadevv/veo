/**
 * Endpoints INTERNOS del OVERLAY de visibilidad de permisos (ADR-025 §3 · Gobierno → Permisos y visibilidad).
 * Montados bajo `/internal/permission-overrides` y consumidos por el admin-bff (Ola 3) y por el runtime de
 * `@veo/policy` (que carga el overlay vigente vía GET). Mismos guards que PoliciesController: InternalIdentityGuard
 * (firma HMAC del BFF · FOUNDATION §10) + AudienceGuard con riel ADMIN_RAIL. El RBAC fino (SUPERADMIN) + step-up
 * MFA los aplica el admin-bff EN EL BORDE: acá no se re-implementan; este service es el STORAGE, el borde la autoridad.
 *  - GET  permission-overrides → todos los pares RESTADOS vigentes (para que `@veo/policy` componga base ∧ ¬override).
 *  - PUT  permission-overrides → aplica {role, permission, hidden}: valida el invariante subtract-only + candado
 *    legal, bumpea version y emite permission_override.updated. actorId = identidad admin-rail firmada.
 */
import { Body, Controller, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Audiences,
  AudienceGuard,
  CurrentUser,
  InternalAudience,
  InternalIdentityGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import {
  PermissionOverridesService,
  type PermissionOverrideView,
} from './permission-overrides.service';
import { SetPermissionOverrideDto } from './dto/permission-overrides.dto';

@ApiTags('permission-overrides')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(InternalAudience.ADMIN_RAIL)
@Controller('internal/permission-overrides')
export class PermissionOverridesController {
  constructor(private readonly overrides: PermissionOverridesService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista los pares (rol, permiso) RESTADOS vigentes (overlay subtract-only). El runtime de @veo/policy ' +
      'compone base ∧ ¬override; ausencia de par = rige la base.',
  })
  list(): Promise<PermissionOverrideView[]> {
    return this.overrides.list();
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Aplica {role, permission, hidden}: valida el invariante subtract-only contra la base + el candado ' +
      'legal-mandatory, bumpea version, persiste + emite permission_override.updated (audit + cache).',
  })
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetPermissionOverrideDto,
  ): Promise<PermissionOverrideView> {
    return this.overrides.set(dto.role, dto.permission, dto.hidden, user.userId);
  }
}
