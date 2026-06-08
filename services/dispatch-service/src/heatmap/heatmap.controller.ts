/**
 * API REST del mapa de calor de demanda (Ola 2C). Protegida con InternalIdentityGuard (la llama
 * driver-bff con la identidad firmada del conductor).
 *  - GET /heatmap?lat&lng&radius → celdas de demanda reciente cerca del conductor.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { HeatmapService } from './heatmap.service';
import { HeatmapQueryDto, HeatmapResponseDto } from './dto/heatmap.dto';

@ApiTags('heatmap')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('heatmap')
export class HeatmapController {
  constructor(private readonly heatmap: HeatmapService) {}

  @Get()
  @ApiOperation({ summary: 'Mapa de calor de demanda (H3) cerca del conductor' })
  get(@Query() query: HeatmapQueryDto): Promise<HeatmapResponseDto> {
    return this.heatmap.heatmap({ lat: query.lat, lon: query.lng }, query.radius);
  }
}
