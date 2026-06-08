import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateInspectionDto {
  @ApiProperty({ description: 'Id del vehículo inspeccionado' })
  @IsUUID()
  vehicleId!: string;

  @ApiProperty({ description: '¿Aprobó la inspección técnica?' })
  @IsBoolean()
  passed!: boolean;

  @ApiPropertyOptional({ description: 'Fecha de inspección (por defecto, ahora)' })
  @IsOptional()
  @IsISO8601()
  inspectedAt?: string;

  @ApiPropertyOptional({ description: 'Id del inspector (por defecto, el operador autenticado)' })
  @IsOptional()
  @IsUUID()
  inspectorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 500)
  notes?: string;
}
