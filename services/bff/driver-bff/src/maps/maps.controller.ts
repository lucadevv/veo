/**
 * Búsqueda de LUGARES del conductor · driver-bff. Espeja al pasajero (public-bff `/maps/*`) para el
 * driver-rail: autocompletar direcciones y etiquetar un punto (reverse). Ambos leen la infra soberana
 * OSRM/Nominatim vía @veo/maps; no crean ni tocan viajes.
 *
 *   GET /maps/autocomplete?q=&lat=&lng=  → sugerencias de direcciones (sesgables por proximidad)
 *   GET /maps/reverse?lat=&lng=          → etiqueta legible del punto ("Tu ubicación")
 *
 * JWT type 'driver' + rate limit (via @DriverApi()): el conductor ya está autenticado antes de buscar.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DriverApi } from '../common/driver-api.decorator';
import { MapsService } from './maps.service';
import {
  AutocompleteQueryDto,
  type PlaceSuggestion,
  ReverseQueryDto,
  type ReversePlace,
} from './dto/maps.dto';

@ApiTags('maps')
@DriverApi()
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
}
