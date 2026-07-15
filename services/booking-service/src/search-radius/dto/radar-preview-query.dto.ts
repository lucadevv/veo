/**
 * DTO de la query del RADAR PREVIEW (GET /internal/booking/radar-preview?lat=&lon=). El centro es un punto
 * (lat/lon); los query params llegan como string → `@Type(() => Number)` los coacciona antes de validar.
 * `@IsLatitude/@IsLongitude` acotan a coordenadas válidas (mismo patrón que SearchPublishedTripsDto).
 */
import { IsLatitude, IsLongitude } from 'class-validator';
import { Type } from 'class-transformer';

export class RadarPreviewQueryDto {
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @Type(() => Number)
  @IsLongitude()
  lon!: number;
}
