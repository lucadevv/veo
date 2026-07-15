/**
 * Endpoints internos de la config de RADIOS (k-rings) + VENTANAS + POLÍTICA v2 de dispatch (espejo del
 * pricing.controller del trip-service). Montados bajo el prefijo global → rutas `/internal/dispatch/...`.
 * Protegidos por InternalIdentityGuard (firma HMAC del BFF, FOUNDATION §10):
 *  - GET  radius-config → config vigente (o el DEFAULT). Lectura: cualquier identidad interna firmada.
 *  - PUT  radius-config → reemplazo + bump version + emite el evento. MUTACIÓN: AdminIdentityGuard exige
 *                         que la identidad firmada sea `admin` (defensa en profundidad).
 *  - GET  radar-preview → densidad REAL de conductores por anillo para la política configurada (planning).
 */
import { Body, Controller, Get, HttpCode, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { DispatchRadiusConfigService } from './dispatch-radius-config.service';
import { AdminIdentityGuard } from './admin-identity.guard';
import { ReplaceRadiusConfigDto } from './dto/dispatch-radius-config.dto';
import { RadarPreviewQueryDto, type RadarPreviewResponse } from './dto/radar-preview.dto';
import { RadarPreviewService } from './radar-preview.service';

@ApiTags('dispatch')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/dispatch')
export class DispatchRadiusConfigController {
  constructor(
    private readonly radiusConfig: DispatchRadiusConfigService,
    private readonly radarPreview: RadarPreviewService,
  ) {}

  @Get('radius-config')
  @ApiOperation({ summary: 'Config de radios (k-rings) + ventanas + política vigente (o el DEFAULT).' })
  getConfig() {
    return this.radiusConfig.getConfig();
  }

  @Put('radius-config')
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard)
  @ApiOperation({
    summary:
      'REEMPLAZA la config de radios/ventanas/política (bump version) y emite ' +
      'dispatch.radius_config_updated. Solo identidad admin.',
  })
  replaceConfig(@Body() dto: ReplaceRadiusConfigDto) {
    return this.radiusConfig.replaceConfig({
      nearbyKRing: dto.nearbyKRing,
      matchKRing: dto.matchKRing,
      offerTimeoutMs: dto.offerTimeoutMs,
      bidWindowSec: dto.bidWindowSec,
      // Ausente → v1 (comportamiento actual). policyV2 solo se usa/persiste cuando policyVersion='v2'.
      policyVersion: dto.policyVersion ?? 'v1',
      policyV2: dto.policyVersion === 'v2' ? (dto.policyV2 ?? null) : null,
    });
  }

  @Get('radar-preview')
  @ApiOperation({
    summary:
      'Densidad REAL de conductores disponibles por anillo para la política de despacho configurada ' +
      '(FIXED = pasos initial→increment→max; PUJA = radio de broadcast). Herramienta de planning.',
  })
  radarPreviewEndpoint(@Query() query: RadarPreviewQueryDto): Promise<RadarPreviewResponse> {
    return this.radarPreview.preview(query.mode, { lat: query.lat, lon: query.lon });
  }
}
