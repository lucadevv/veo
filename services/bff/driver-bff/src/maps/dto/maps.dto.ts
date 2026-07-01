import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * GET /maps/autocomplete?q=&lat=&lng= — texto parcial + sesgo opcional por proximidad.
 * Espeja el DTO del public-bff (mismo contrato de mapas soberano @veo/maps): `lng` es la convención
 * MapLibre que ya usa la app; el service la convierte al `lon` interno de @veo/maps.
 */
export class AutocompleteQueryDto {
  @ApiProperty({ example: 'Av. Larco', description: 'Texto parcial a autocompletar' })
  @IsString()
  @MaxLength(120)
  q!: string;

  @ApiPropertyOptional({ example: -12.1211, description: 'Latitud para sesgar por proximidad' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: -77.0297, description: 'Longitud para sesgar por proximidad' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;
}

/** GET /maps/reverse?lat=&lng= — etiqueta legible del punto (p. ej. "Tu ubicación"). */
export class ReverseQueryDto {
  @ApiProperty({ example: -12.0464 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428 })
  @Type(() => Number)
  @IsLongitude()
  lng!: number;
}

/* ── Formas de respuesta (espejan los contratos de @veo/api-client) ── */

/** Sugerencia de dirección del autocompletado. */
export interface PlaceSuggestion {
  id: string;
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
}

/** Etiqueta de un punto (reverse geocoding). */
export interface ReversePlace {
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
}
