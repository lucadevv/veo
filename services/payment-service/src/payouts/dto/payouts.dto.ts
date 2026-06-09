import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PayoutStatus } from '../../generated/prisma';

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

/** Listado admin de TODOS los payouts: filtro por estado + paginación cursor. */
export class ListAllPayoutsQueryDto {
  @ApiPropertyOptional({ enum: PayoutStatus, description: 'Filtra por estado del payout' })
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;

  @ApiPropertyOptional({ description: 'Cursor (id del último payout de la página previa)' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, description: 'Tamaño de página (default 25)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
