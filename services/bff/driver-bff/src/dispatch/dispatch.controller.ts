/**
 * Ofertas de dispatch (lado conductor). JWT de tipo 'driver'.
 */
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DriverApi } from '../common/driver-api.decorator';
import { DispatchService } from './dispatch.service';
import { SurgeQueryDto, type OfferView, type SurgeView } from './dto/dispatch.dto';

@ApiTags('dispatch')
@DriverApi()
@Controller('dispatch')
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get('surge')
  @ApiOperation({ summary: 'Cotiza el surge para un origen (lat/lon)' })
  surge(@Query() query: SurgeQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<SurgeView> {
    return this.dispatch.getSurge(query.lat, query.lon, user);
  }

  @Get('offers/:matchId')
  @ApiOperation({ summary: 'Leer una oferta/match por id' })
  getOffer(
    @Param('matchId', ParseUUIDPipe) matchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OfferView> {
    return this.dispatch.getOffer(matchId, user);
  }

  @Post('offers/:matchId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor acepta la oferta' })
  accept(
    @Param('matchId', ParseUUIDPipe) matchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.dispatch.accept(matchId, user);
  }

  @Post('offers/:matchId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor rechaza la oferta' })
  reject(
    @Param('matchId', ParseUUIDPipe) matchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.dispatch.reject(matchId, user);
  }
}
