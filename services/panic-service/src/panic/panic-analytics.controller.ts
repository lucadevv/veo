/**
 * Endpoint interno de analítica del pánico para el dashboard admin (KPI "pánicos abiertos").
 * Montado bajo el prefijo global → ruta `api/v1/internal/analytics/open-count`. Protegido por
 * InternalIdentityGuard (firma HMAC del BFF, FOUNDATION §10): lectura de cualquier identidad interna firmada.
 *  - GET open-count → conteo de pánicos ABIERTOS (TRIGGERED + ACKNOWLEDGED): los que aún requieren
 *    atención del operador. NO cuenta los cerrados (RESOLVED ni FALSE_ALARM).
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { PanicService } from './panic.service';

@ApiTags('panic')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/analytics')
export class PanicAnalyticsController {
  constructor(private readonly panic: PanicService) {}

  @Get('open-count')
  @ApiOperation({
    summary: 'KPI dashboard: cantidad de pánicos ABIERTOS (TRIGGERED + ACKNOWLEDGED, no resueltos).',
  })
  async openCount(): Promise<{ openPanics: number }> {
    return { openPanics: await this.panic.countOpen() };
  }
}
