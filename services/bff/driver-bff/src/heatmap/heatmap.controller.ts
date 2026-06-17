import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type { HeatmapView } from '@veo/api-client';
import { DriverApi } from '../common/driver-api.decorator';
import { HeatmapService } from './heatmap.service';
import { HeatmapQueryDto } from './dto/heatmap.dto';

@ApiTags('heatmap')
@DriverApi()
@Controller('heatmap')
export class HeatmapController {
  constructor(private readonly heatmap: HeatmapService) {}

  @Get()
  @ApiOperation({ summary: 'Mapa de calor de demanda cerca del conductor (Ola 2C)' })
  get(
    @Query() query: HeatmapQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HeatmapView> {
    return this.heatmap.get(user, query.lat, query.lng, query.radius);
  }
}
