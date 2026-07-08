import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** Query de paginación del historial de conciliación (cursor por id descendente, uuidv7 ⇒ cronológico). */
export class ListReconciliationQueryDto {
  @ApiPropertyOptional({ description: 'Cursor (id de la última corrida de la página previa)' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, description: 'Tamaño de página (default 30)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * DEV-ONLY · Body del trigger manual de la conciliación (`POST /reconciliation/run`). El cron diario 04:00
 * concilia el día previo; este disparador permite forzarlo bajo demanda en dev. `date` opcional (YYYY-MM-DD,
 * UTC): concilia ESE día [00:00, 00:00). Ausente → día previo (mismo default que el cron).
 */
export class RunReconciliationDto {
  @ApiPropertyOptional({
    description: 'Día a conciliar (YYYY-MM-DD, UTC). Ausente = día previo (default del cron).',
    example: '2026-07-06',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date debe tener formato YYYY-MM-DD' })
  date?: string;
}
