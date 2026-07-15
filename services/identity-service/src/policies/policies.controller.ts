/**
 * Endpoints INTERNOS del registro PBAC (ADR-024 §6 · Gobierno → Políticas). Montados bajo `/internal/policies`
 * y consumidos por el admin-bff. Protegidos por InternalIdentityGuard (firma HMAC del BFF · FOUNDATION §10) +
 * AudienceGuard con riel ADMIN_RAIL (la identidad interna firmada debe ser del carril admin) — espejo del guard
 * de AdminController. El RBAC fino (SUPERADMIN) + el step-up MFA los aplica el admin-bff EN EL BORDE (Ola 3): acá
 * no se re-implementan; este service es el STORAGE, el borde es la autoridad.
 *  - GET  policies       → todas las políticas vigentes (la grilla).
 *  - GET  policies/:key  → una política.
 *  - PUT  policies/:key  → aplica {enabled?, params?}, bumpea version y emite policy.updated. actorId = identidad firmada.
 */
import { Body, Controller, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Audiences,
  AudienceGuard,
  CurrentUser,
  InternalAudience,
  InternalIdentityGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { PoliciesService, type PolicyView, type PolicyVersionView } from './policies.service';
import { UpdatePolicyDto } from './dto/policies.dto';

@ApiTags('policies')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard, AudienceGuard)
@Audiences(InternalAudience.ADMIN_RAIL)
@Controller('internal/policies')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista todas las políticas de gobierno vigentes (grilla del admin).' })
  list(): Promise<PolicyView[]> {
    return this.policies.list();
  }

  @Get(':key')
  @ApiOperation({ summary: 'Una política de gobierno por su key.' })
  get(@Param('key') key: string): Promise<PolicyView> {
    return this.policies.get(key);
  }

  @Get(':key/history')
  @ApiOperation({
    summary:
      'Historial de cambios de una política (timeline · más reciente primero). [] si aún no tiene cambios.',
  })
  history(@Param('key') key: string): Promise<PolicyVersionView[]> {
    return this.policies.history(key);
  }

  @Put(':key')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Aplica {enabled?, params?} a una política: valida params, bumpea version, persiste + emite ' +
      'policy.updated (audit + cache). Rechaza desactivar una política obligatoria.',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Body() dto: UpdatePolicyDto,
  ): Promise<PolicyView> {
    return this.policies.update(
      key,
      { enabled: dto.enabled, params: dto.params, expectedVersion: dto.expectedVersion },
      user.userId,
    );
  }
}
