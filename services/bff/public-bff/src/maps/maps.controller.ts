import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { MapsService } from './maps.service';
import {
  AutocompleteQueryDto,
  type PlaceSuggestion,
  QuoteRequestDto,
  type QuoteResult,
  ReverseQueryDto,
  type ReversePlace,
} from './dto/maps.dto';

/**
 * Endpoints de mapas para la UX de previsualización del pasajero (búsqueda, etiqueta y cotización).
 * Requieren JWT como el resto del BFF (el guard global `JwtAuthGuard` aplica): el pasajero ya hizo
 * OTP antes de buscar destinos, así que no se exponen sin auth. No tocan trip-service.
 */
@ApiTags('maps')
@ApiBearerAuth()
@Controller('maps')
export class MapsController {
  constructor(private readonly maps: MapsService) {}

  @Get('autocomplete')
  @ApiOperation({ summary: 'Autocompletado de direcciones (Nominatim, sesgable por proximidad)' })
  autocomplete(@Query() query: AutocompleteQueryDto): Promise<PlaceSuggestion[]> {
    return this.maps.autocomplete(query.q, query.lat, query.lng);
  }

  @Get('reverse')
  @ApiOperation({ summary: 'Reverse geocoding del punto (etiqueta "Tu ubicación")' })
  reverse(@Query() query: ReverseQueryDto): Promise<ReversePlace> {
    return this.maps.reverse(query.lat, query.lng);
  }

  @Post('quote')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cotización ligera: ruta + ETA + tarifa por categoría + modo PUJA/FIXED (ADR 011, sin crear viaje)',
  })
  quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: QuoteRequestDto,
  ): Promise<QuoteResult> {
    return this.maps.quote(dto, user);
  }
}
