import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

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
