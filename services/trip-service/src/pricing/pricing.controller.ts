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
import { PricingScheduleService } from './pricing-schedule.service';
import { AdminIdentityGuard } from './admin-identity.guard';
import { ReplaceScheduleDto } from './dto/pricing.dto';
import { ResolveQueryDto } from './dto/resolve-query.dto';
import { toZone } from '../trips/domain/pricing-mode';

@ApiTags('pricing')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/pricing')
export class PricingController {
  constructor(private readonly pricing: PricingScheduleService) {}

  @Get('mode-schedule')
  @ApiOperation({ summary: 'Schedule de modo vigente (o el default PUJA si no hay config). ADR 011' })
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
    return this.pricing.replaceSchedule({ defaultMode: dto.defaultMode, rules: dto.rules });
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
