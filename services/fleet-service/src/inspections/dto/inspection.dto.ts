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

  // NO existe `inspectorId` en el body: la identidad del inspector es server-truth (el actor autenticado del
  // JWT), NUNCA client-supplied. Aceptarla la haría spoofeable y rompería la integridad del audit de
  // compliance (quién inspeccionó). El service lo fija desde `user.userId` del controller.

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 500)
  notes?: string;

  @ApiPropertyOptional({ description: 'Centro de Inspección Técnica Vehicular (CITV) donde se realizó' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  center?: string;
}
