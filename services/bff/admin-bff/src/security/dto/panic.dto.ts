/** DTOs de los endpoints de seguridad (pánico). */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const PANIC_STATUSES = ['TRIGGERED', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_ALARM'] as const;

export class ListPanicsQueryDto {
  @IsOptional()
  @IsIn(PANIC_STATUSES)
  status?: (typeof PANIC_STATUSES)[number];
}

export class ResolvePanicDto {
  @IsIn(['RESOLVED', 'FALSE_ALARM'])
  resolution!: 'RESOLVED' | 'FALSE_ALARM';

  /**
   * Motivo OPCIONAL del cierre. No lo persiste panic-service (su entidad no tiene columna de notas): se
   * registra en el AUDIT (rendición de cuentas · Ley 29733). `forbidNonWhitelisted` exige declararlo aquí.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class PanicEvidenceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  keys!: string[];

  @IsOptional()
  @IsBoolean()
  finalize?: boolean;
}
