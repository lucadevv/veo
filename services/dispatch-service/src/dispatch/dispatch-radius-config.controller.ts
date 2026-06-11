/**
 * Endpoints internos de la config de RADIOS (k-rings) de dispatch (espejo del pricing.controller del
 * trip-service). Montados bajo el prefijo global → rutas `/internal/dispatch/radius-config`. Protegidos
 * por InternalIdentityGuard (firma HMAC del BFF, FOUNDATION §10):
 *  - GET  radius-config → config vigente (o el DEFAULT). Lectura: cualquier identidad interna firmada.
 *  - PUT  radius-config → reemplazo + bump version + emite el evento. MUTACIÓN: AdminIdentityGuard exige
 *                         que la identidad firmada sea `admin` (defensa en profundidad).
 */
import { Body, Controller, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { DispatchRadiusConfigService } from './dispatch-radius-config.service';
import { AdminIdentityGuard } from './admin-identity.guard';
import { ReplaceRadiusConfigDto } from './dto/dispatch-radius-config.dto';

@ApiTags('dispatch')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/dispatch')
export class DispatchRadiusConfigController {
  constructor(private readonly radiusConfig: DispatchRadiusConfigService) {}

  @Get('radius-config')
  @ApiOperation({ summary: 'Config de radios (k-rings) vigente (o el DEFAULT si no hay config).' })
  getConfig() {
    return this.radiusConfig.getConfig();
  }

  @Put('radius-config')
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard)
  @ApiOperation({
    summary:
      'REEMPLAZA la config de radios (bump version) y emite dispatch.radius_config_updated. ' +
      'Solo identidad admin.',
  })
  replaceConfig(@Body() dto: ReplaceRadiusConfigDto) {
    return this.radiusConfig.replaceConfig({
      nearbyKRing: dto.nearbyKRing,
      matchKRing: dto.matchKRing,
    });
  }
}
