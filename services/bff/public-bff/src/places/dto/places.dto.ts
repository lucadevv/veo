import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsLatitude, IsLongitude, IsOptional, IsString, Length } from 'class-validator';

/**
 * Tipos de lugar guardado (espejan el enum veo.places.v1.PlaceKind).
 * HOME/WORK son únicos por usuario (upsert); FAVORITE admite múltiples (con tope server-side).
 */
export const PLACE_KINDS = ['HOME', 'WORK', 'FAVORITE'] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** Cuerpo de creación (POST /places). El userId NUNCA viaja en el cuerpo (anti-IDOR): sale del JWT. */
export class SavePlaceDto {
  @ApiProperty({ enum: PLACE_KINDS, example: 'HOME' })
  @IsIn(PLACE_KINDS, { message: 'kind debe ser HOME, WORK o FAVORITE' })
  kind!: PlaceKind;

  @ApiProperty({ example: 'Casa', description: 'Etiqueta visible del lugar (1..40)' })
  @IsString()
  @Length(1, 40)
  label!: string;

  @ApiPropertyOptional({ example: 'Av. Larco 123, Miraflores' })
  @IsOptional()
  @IsString()
  @Length(0, 120)
  subtitle?: string;

  @ApiProperty({ example: -12.121, description: 'Latitud (WGS84)' })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: -77.029, description: 'Longitud (WGS84)' })
  @IsLongitude()
  lng!: number;
}

/** Cuerpo de actualización (PUT /places/:id). Mismos campos que la creación. */
export class UpdatePlaceDto extends SavePlaceDto {}

/** Vista pública de un lugar guardado (respuesta REST). */
export interface PlaceView {
  id: string;
  kind: PlaceKind;
  label: string;
  subtitle: string | null;
  lat: number;
  lng: number;
  createdAt: string;
  updatedAt: string;
}
