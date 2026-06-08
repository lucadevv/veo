/** Filtros del listado de auditoría. */
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AuditQueryDto {
  @IsOptional()
  @IsString()
  resourceType?: string;

  @IsOptional()
  @IsString()
  resourceId?: string;

  @IsOptional()
  @IsString()
  actorId?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  /** Cursor: devuelve entradas con seq < beforeSeq (orden descendente). */
  @IsOptional()
  @IsString()
  beforeSeq?: string;
}

export class AuditVerifyDto {
  @IsOptional()
  @IsString()
  fromSeq?: string;

  @IsOptional()
  @IsString()
  toSeq?: string;
}
