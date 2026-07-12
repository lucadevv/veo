import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PayoutStatus } from '../../generated/prisma';

/** Filtro del export CSV: un PayoutStatus concreto o 'ALL' (todo el set). `undefined` se trata como ALL. */
export const EXPORT_STATUS_ALL = 'ALL';
export type ExportPayoutStatus = PayoutStatus | typeof EXPORT_STATUS_ALL;

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

/** Export CSV de payouts: filtro por estado (o 'ALL' = todo el set). Sin paginación (exporta el filtro entero). */
export class ExportPayoutsQueryDto {
  @ApiPropertyOptional({
    enum: [...Object.values(PayoutStatus), EXPORT_STATUS_ALL],
    description: "Filtra por estado del payout, o 'ALL' para todo el set (default ALL)",
  })
  @IsOptional()
  @IsIn([...Object.values(PayoutStatus), EXPORT_STATUS_ALL])
  status?: ExportPayoutStatus;
}
