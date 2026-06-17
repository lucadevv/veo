/**
 * Endpoints internos del schedule de modo de pricing (ADR 011 §3). Montados bajo el prefijo global
 * `api/v1` → rutas efectivas `/api/v1/internal/pricing/...`. Protegidos por InternalIdentityGuard
 * (firma HMAC del BFF, FOUNDATION §10):
 *  - GET  mode-schedule  → schedule vigente (o el default). Lectura: cualquier identidad interna firmada.
 *  - PUT  mode-schedule  → reemplazo wholesale + emite el evento. MUTACIÓN: AdminIdentityGuard exige
 *                          que la identidad firmada sea `admin` (defensa en profundidad; el RBAC
 *                          `pricing:manage` se aplica además en admin-bff).
 *  - GET  resolve        → { mode } para (lat,lon, ahora). Lectura (public-bff quote, M4): cualquier
 *                          identidad interna firmada.
 */
import { Body, Controller, Get, HttpCode, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { ENERGY_SOURCE_UNIT } from '@veo/shared-types';
import { PricingScheduleService } from './pricing-schedule.service';
import { FuelSurchargeService } from './fuel-surcharge.service';
import { EnergyCatalogService } from './energy-catalog.service';
import { BidFloorService } from './bid-floor.service';
import { AdminIdentityGuard } from './admin-identity.guard';
import { ReplaceScheduleDto, ReplaceFuelSurchargeDto } from './dto/pricing.dto';
import { ReplaceEnergyCatalogDto } from './dto/energy-catalog.dto';
import { ReplaceBidFloorDto } from './dto/bid-floor.dto';
import { ResolveQueryDto } from './dto/resolve-query.dto';
import { toZone } from '../trips/domain/pricing-mode';

@ApiTags('pricing')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/pricing')
export class PricingController {
  constructor(
    private readonly pricing: PricingScheduleService,
    private readonly fuel: FuelSurchargeService,
    private readonly energy: EnergyCatalogService,
    private readonly bidFloor: BidFloorService,
  ) {}

  @Get('mode-schedule')
  @ApiOperation({
    summary: 'Schedule de modo vigente (o el default PUJA si no hay config). ADR 011',
  })
  getSchedule() {
    return this.pricing.getSchedule();
  }

  @Put('mode-schedule')
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard)
  @ApiOperation({
    summary:
      'REEMPLAZA wholesale el schedule de modo (bump version) y emite pricing.mode_schedule_updated. ' +
      'Solo identidad admin (ADR 011 §6).',
  })
  replaceSchedule(@Body() dto: ReplaceScheduleDto) {
    return this.pricing.replaceSchedule({
      defaultMode: dto.defaultMode,
      rules: dto.rules,
      expectedVersion: dto.expectedVersion,
    });
  }

  @Get('fuel-surcharge')
  @ApiOperation({ summary: 'Recargo de combustible por km vigente (o 0 si no hay config). B3' })
  getFuelSurcharge() {
    return this.fuel.getConfig();
  }

  @Put('fuel-surcharge')
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard)
  @ApiOperation({
    summary:
      'REEMPLAZA el recargo de combustible por km (bump version) y emite fuel.surcharge_updated. ' +
      'Solo identidad admin (B3).',
  })
  replaceFuelSurcharge(@Body() dto: ReplaceFuelSurchargeDto) {
    return this.fuel.replace(dto.fuelPricePerLiterCents, dto.kmPerLiter, dto.expectedVersion);
  }

  @Get('energy-catalog')
  @ApiOperation({
    summary: 'Catálogo de precios de energía por fuente vigente (o vacío si no hay config). B5',
  })
  getEnergyCatalog() {
    return this.energy.getCatalog();
  }

  @Put('energy-catalog')
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard)
  @ApiOperation({
    summary:
      'REEMPLAZA wholesale el catálogo de energía (precios por fuente, bump version) y emite ' +
      'energy.catalog_updated. La `unit` se deriva de la fuente (no se ingresa). Solo identidad admin (B5).',
  })
  replaceEnergyCatalog(@Body() dto: ReplaceEnergyCatalogDto) {
    // La unidad NO la elige el admin: se deriva de la fuente (gasolina→litro, eléctrico→kWh).
    const sources = dto.sources.map((s) => ({
      sourceId: s.sourceId,
      unit: ENERGY_SOURCE_UNIT[s.sourceId],
      pricePerUnitCents: s.pricePerUnitCents,
    }));
    return this.energy.replace(sources, dto.expectedVersion);
  }

  @Get('bid-floor')
  @ApiOperation({
    summary:
      'Piso de la PUJA vigente (default + overrides por oferta, o el default S/7). ADR 010 §9.3',
  })
  getBidFloor() {
    return this.bidFloor.getConfig();
  }

  @Put('bid-floor')
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard)
  @ApiOperation({
    summary:
      'REEMPLAZA wholesale el piso de la PUJA (default + overrides por oferta, bump version) y emite ' +
      'pricing.bid_floor_updated. Solo identidad admin (ADR 010 §9.3).',
  })
  replaceBidFloor(@Body() dto: ReplaceBidFloorDto) {
    return this.bidFloor.replace({
      defaultFloorCents: dto.defaultFloorCents,
      overrides: dto.overrides,
      expectedVersion: dto.expectedVersion,
    });
  }

  @Get('resolve')
  @ApiOperation({
    summary:
      'Resuelve el modo { mode } para (lat,lon, at?). `at` (ISO) opcional: instante a resolver; default ' +
      'ahora. El quote de una reserva pasa la hora de RECOJO (S2). Usado por el quote (M4).',
  })
  async resolve(@Query() query: ResolveQueryDto): Promise<{ mode: string }> {
    // S2 — resolvemos para `at` (la hora de recojo del quote de una reserva) o `now` si no se envía.
    const at = query.at ? new Date(query.at) : new Date();
    const mode = await this.pricing.resolve(toZone({ lat: query.lat, lon: query.lon }), at);
    return { mode };
  }
}
