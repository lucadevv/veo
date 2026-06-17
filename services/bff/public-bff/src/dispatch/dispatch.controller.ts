import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DispatchService } from './dispatch.service';
import { SurgeQueryDto, type SurgeView } from './dto/surge-query.dto';
import { NearbyQueryDto, type NearbyVehiclesView } from './dto/nearby-query.dto';

@ApiTags('dispatch')
@ApiBearerAuth()
@Controller('dispatch')
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get('surge')
  @ApiOperation({ summary: 'Multiplicador de surge en una ubicación' })
  surge(@CurrentUser() user: AuthenticatedUser, @Query() query: SurgeQueryDto): Promise<SurgeView> {
    return this.dispatch.getSurge(user, query.lat, query.lon);
  }

  @Get('nearby')
  @ApiOperation({ summary: 'Conductores cercanos ANÓNIMOS (mapa del pasajero "buscando")' })
  nearby(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: NearbyQueryDto,
  ): Promise<NearbyVehiclesView> {
    return this.dispatch.getNearby(user, query.lat, query.lon, query.vehicleType);
  }
}
