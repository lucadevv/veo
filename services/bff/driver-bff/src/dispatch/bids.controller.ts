/**
 * API de la PUJA para el conductor (ADR 010 §6). JWT de tipo 'driver'. El driverId NUNCA llega del
 * cliente: el dispatch.service lo DERIVA de la identidad autenticada (GetDriverByUser) y lo firma en
 * la identidad interna. El gate de elegibilidad (online + biométrico + !suspendido + vehículo) lo
 * enforce dispatch downstream — su 403 se propaga limpio (cierre estructural del catastrófico #9).
 *
 *  - GET  /bids                 → pujas OPEN cercanas que este conductor elegible puede ofertar.
 *  - POST /bids/:tripId/offer   → submit oferta/contraoferta sobre una puja.
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DriverApi } from '../common/driver-api.decorator';
import { DispatchService } from './dispatch.service';
import { SubmitOfferDto, type OpenBidView, type SubmittedOfferView } from './dto/dispatch.dto';

@ApiTags('bids')
@DriverApi()
@Controller('bids')
export class BidsController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get()
  @ApiOperation({ summary: 'Pujas OPEN cercanas que el conductor elegible puede ofertar' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<OpenBidView[]> {
    return this.dispatch.listOpenBids(user);
  }

  @Post(':tripId/offer')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Enviar oferta/contraoferta a una puja (gate de elegibilidad downstream)',
  })
  offer(
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: SubmitOfferDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SubmittedOfferView> {
    return this.dispatch.submitOffer(tripId, dto.kind, dto.priceCents, user);
  }
}
