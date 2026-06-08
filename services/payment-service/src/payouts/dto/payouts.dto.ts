import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

export class RunPayoutsDto {
  @ApiPropertyOptional({ description: 'Inicio del período (ISO). Por defecto, la semana previa' })
  @IsOptional()
  @IsISO8601()
  periodStart?: string;

  @ApiPropertyOptional({ description: 'Fin del período (ISO). Por defecto, la semana previa' })
  @IsOptional()
  @IsISO8601()
  periodEnd?: string;
}

export class ListPayoutsQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Filtra por conductor' })
  @IsOptional()
  @IsUUID()
  driverId?: string;
}
