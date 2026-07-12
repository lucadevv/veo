/**
 * DTO del GET /internal/dispatch/radar-preview — vista de PLANNING de la densidad real de conductores por
 * anillo, para la política de despacho configurada. Query: mode (FIXED|PUJA) + lat/lon del centro.
 */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsLatitude, IsLongitude } from 'class-validator';

/** Modo de despacho a previsualizar (FIXED = oferta directa; PUJA = broadcast del bid). */
export type RadarPreviewMode = 'FIXED' | 'PUJA';

export class RadarPreviewQueryDto {
  @ApiProperty({ enum: ['FIXED', 'PUJA'], example: 'FIXED' })
  @IsIn(['FIXED', 'PUJA'])
  mode!: RadarPreviewMode;

  @ApiProperty({ example: -12.0464, description: 'Latitud del centro' })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.0428, description: 'Longitud del centro' })
  @Type(() => Number)
  @IsLongitude()
  lon!: number;
}

/** Un anillo del radar: su radio en km, el k-ring H3 equivalente, y la cuenta REAL de disponibles. */
export interface RadarPreviewRing {
  radiusKm: number;
  kRing: number;
  driverCount: number;
}

/** Una POSICIÓN (lat/lon) de un conductor disponible para plotear en el mapa del radar admin. Sin PII. */
export interface RadarDriverPosition {
  lat: number;
  lon: number;
}

/** Respuesta del radar-preview. `totalInRange` = disponibles dentro del anillo más ancho (cúmulo). */
export interface RadarPreviewResponse {
  mode: RadarPreviewMode;
  center: { lat: number; lon: number };
  rings: RadarPreviewRing[];
  totalInRange: number;
  /**
   * MUESTRA DEDUPEADA (capada a 100) de posiciones reales de los conductores disponibles del anillo MÁS ANCHO,
   * para que el mapa del admin plotee marcadores reales (no solo conteos por anillo). `[]` sin conductores.
   */
  drivers: RadarDriverPosition[];
}
