/**
 * Endpoints INTERNOS del radio de búsqueda del carpooling (F2 · espejo del dispatch-radius-config.controller).
 * Montados bajo el prefijo global `api/v1` → rutas `/api/v1/internal/booking/...`. Protegidos por
 * InternalIdentityGuard (firma HMAC del BFF, FOUNDATION §10):
 *  - GET  search-radius-config → config vigente (o el DEFAULT del env). Lectura: cualquier identidad interna firmada.
 *  - PUT  search-radius-config → reemplazo + bump version + emite booking.search_radius_config_updated. MUTACIÓN:
 *                                AdminIdentityGuard exige que la identidad firmada sea `admin` (defensa en profundidad).
 *  - GET  radar-preview        → densidad real de ofertas disponibles por radio (base/expand) alrededor de un punto.
 *                                Lectura interna (preview del impacto del radio antes de aplicarlo).
 *
 * El controller vive en PublishedTripsModule (no en CarpoolSearchConfigModule) porque el radar-preview reusa
 * PublishedTripsService (índice H3 de published-trips) — así ambos deps conviven sin ciclo de módulos.
 */
import { Body, Controller, Get, HttpCode, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { CarpoolSearchConfigService } from './carpool-search-config.service';
import { AdminIdentityGuard } from './admin-identity.guard';
import { ReplaceSearchRadiusConfigDto } from './dto/replace-search-radius-config.dto';
import { RadarPreviewQueryDto } from './dto/radar-preview-query.dto';
import type { PersistedSearchConfig } from './carpool-search-config.repository';
import { PublishedTripsService, type RadarPreview } from '../published-trips/published-trips.service';

@ApiTags('booking')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/booking')
export class SearchRadiusController {
  constructor(
    private readonly searchConfig: CarpoolSearchConfigService,
    private readonly publishedTrips: PublishedTripsService,
  ) {}

  @Get('search-radius-config')
  @ApiOperation({
    summary:
      'Radio de búsqueda del carpooling vigente (baseRadiusKm/expandRadiusKm en km) + version (o el DEFAULT si no hay config). F2',
  })
  getConfig(): Promise<PersistedSearchConfig> {
    return this.searchConfig.getConfig();
  }

  @Put('search-radius-config')
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard)
  @ApiOperation({
    summary:
      'REEMPLAZA el radio de búsqueda (bump version) y emite booking.search_radius_config_updated. Autoaplica (cache invalidado). Solo identidad admin. F2',
  })
  replaceConfig(@Body() dto: ReplaceSearchRadiusConfigDto): Promise<PersistedSearchConfig> {
    return this.searchConfig.replaceConfig({
      baseRadiusKm: dto.baseRadiusKm,
      expandRadiusKm: dto.expandRadiusKm,
    });
  }

  @Get('radar-preview')
  @ApiOperation({
    summary:
      'Densidad REAL de ofertas de carpooling disponibles por radio (base/expand) alrededor de un punto. Reusa el índice H3 de published-trips. F2',
  })
  radarPreview(@Query() query: RadarPreviewQueryDto): Promise<RadarPreview> {
    return this.publishedTrips.radarPreview(query.lat, query.lon);
  }
}
