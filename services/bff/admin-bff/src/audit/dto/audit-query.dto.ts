/** Filtros del listado de auditoría. */
import { IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
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

  /** Categoría = prefijo de dominio de la acción (payment/driver/media…). Lo traduce audit-service a startsWith. */
  @IsOptional()
  @IsString()
  category?: string;

  /** Búsqueda libre (el buscador del panel) sobre acción/recurso/actor. */
  @IsOptional()
  @IsString()
  q?: string;

  /** Rango de fecha (inclusive) sobre occurredAt. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  /**
   * Cursor de paginación del panel: seq de la última fila cargada → devuelve entradas con seq < cursor. Es el
   * mismo cursor que emite `list` como `nextCursor`; el bff lo mapea a `beforeSeq` de audit-service.
   */
  @IsOptional()
  @IsString()
  cursor?: string;
}

/** Filtros del export (GET /audit/export): los MISMOS estructurados del listado, sin cursor/limit (set completo). */
export class AuditExportQueryDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class AuditVerifyDto {
  @IsOptional()
  @IsString()
  fromSeq?: string;

  @IsOptional()
  @IsString()
  toSeq?: string;
}
