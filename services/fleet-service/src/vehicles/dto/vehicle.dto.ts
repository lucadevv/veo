import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsISO8601, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { VehicleType } from '@veo/shared-types';
import type { VehicleReviewStatus } from '../vehicle-rules';

const CURRENT_YEAR = new Date().getUTCFullYear();

/** Año mínimo aceptado por la validación de forma (sanity check); BR-D04 (>=2017) se valida en el servicio. */
const MIN_REASONABLE_YEAR = 2005;

/** Placa peruana: XXX-XXX (guion opcional). El servicio normaliza y revalida con plateSchema (@veo/utils). */
const PLATE_PATTERN = /^[A-Z0-9]{3}-?[A-Z0-9]{3}$/i;

export class CreateVehicleDto {
  @ApiProperty({ example: 'ABC-123', description: 'Placa peruana (ABC-123 / A1B-234)' })
  @IsString()
  plate!: string;

  @ApiProperty({ example: 'Toyota' })
  @IsString()
  @Length(1, 60)
  make!: string;

  @ApiProperty({ example: 'Yaris' })
  @IsString()
  @Length(1, 60)
  model!: string;

  @ApiProperty({ example: 2020, description: 'BR-D04: año >= VEHICLE_MIN_YEAR (2017)' })
  @IsInt()
  @Min(1980)
  @Max(CURRENT_YEAR + 1)
  year!: number;

  @ApiProperty({ example: 'Plata' })
  @IsString()
  @Length(1, 30)
  color!: string;

  @ApiPropertyOptional({
    enum: VehicleType,
    default: VehicleType.CAR,
    description: 'Tipo de vehículo (Ola 2B · moto-taxi). MOTO habilita el matching de viajes MOTO.',
  })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;

  @ApiPropertyOptional({ description: 'Id de la flota a la que pertenece (si aplica)' })
  @IsOptional()
  @IsString()
  fleetId?: string;

  @ApiPropertyOptional({ description: 'Vencimiento del seguro (SOAT/póliza)', example: '2026-12-31T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  insuranceExpiresAt?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * Alta self-service del conductor (onboarding). El vehículo queda asociado al conductor
 * (driverId del header de identidad interna) y pendiente de verificación (active=false).
 */
export class RegisterDriverVehicleDto {
  @ApiProperty({
    enum: VehicleType,
    description: 'Tipo de vehículo. CAR = automóvil; MOTO = moto-taxi (Ola 2B).',
  })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiProperty({ example: 'ABC-123', description: 'Placa peruana (XXX-XXX, guion opcional)' })
  @IsString()
  @Matches(PLATE_PATTERN, { message: 'Placa inválida (formato XXX-XXX)' })
  plate!: string;

  @ApiProperty({ example: 'Honda' })
  @IsString()
  @Length(1, 60)
  make!: string;

  @ApiProperty({ example: 'CG 150' })
  @IsString()
  @Length(1, 60)
  model!: string;

  @ApiProperty({ example: 2021, description: `Año del vehículo (>= ${MIN_REASONABLE_YEAR}). BR-D04 (>=2017) se aplica en el servicio.` })
  @IsInt()
  @Min(MIN_REASONABLE_YEAR)
  @Max(CURRENT_YEAR + 1)
  year!: number;

  @ApiPropertyOptional({ example: 'Rojo' })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  color?: string;
}

/** Respuesta del alta/consulta self-service: subconjunto del vehículo + estado de revisión derivado. */
export interface DriverVehicleResponse {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  vehicleType: VehicleType;
  docStatus: string;
  status: VehicleReviewStatus;
}
