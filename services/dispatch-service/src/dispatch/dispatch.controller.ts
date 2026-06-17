/**
 * API REST de dispatch (protegida con InternalIdentityGuard; la llama driver-bff).
 *  - POST /dispatch/offers/:matchId/accept  → el conductor acepta la oferta.
 *  - POST /dispatch/offers/:matchId/reject  → el conductor rechaza la oferta.
 *  - GET  /dispatch/offers/:matchId         → lectura del match.
 *  - GET  /dispatch/surge?lat&lon           → cotiza el multiplier de surge para un origen.
 */
import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { DispatchService } from './dispatch.service';
import { SurgeService } from './surge.service';
import { requireDriverId } from './require-driver-id';
import { MatchResponseDto, SurgeQueryDto, SurgeResponseDto } from './dto/dispatch.dto';

@ApiTags('dispatch')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('dispatch')
export class DispatchController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly surge: SurgeService,
  ) {}

  @Post('offers/:matchId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor acepta la oferta (publica dispatch.match_found)' })
  accept(
    @Param('matchId', ParseUUIDPipe) matchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MatchResponseDto> {
    // El driverId sale de la identidad FIRMADA (anti-IDOR #9): un conductor solo opera su propia oferta.
    return this.dispatch.accept(matchId, requireDriverId(user));
  }

  @Post('offers/:matchId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'El conductor rechaza la oferta (se ofrece al siguiente candidato)' })
  reject(
    @Param('matchId', ParseUUIDPipe) matchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MatchResponseDto> {
    return this.dispatch.reject(matchId, requireDriverId(user));
  }

  @Get('offers/:matchId')
  @ApiOperation({ summary: 'Lee el estado de un match' })
  getMatch(
    @Param('matchId', ParseUUIDPipe) matchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MatchResponseDto> {
    return this.dispatch.getMatch(matchId, requireDriverId(user));
  }

  @Get('surge')
  @ApiOperation({
    summary: 'Cotiza el multiplier de surge para un origen (lo usa trip en la tarifa)',
  })
  quoteSurge(@Query() query: SurgeQueryDto): Promise<SurgeResponseDto> {
    return this.surge.quote({ lat: query.lat, lon: query.lon });
  }
}
