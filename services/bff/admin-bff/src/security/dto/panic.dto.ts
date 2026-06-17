/** DTOs de los endpoints de seguridad (pánico). */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
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
