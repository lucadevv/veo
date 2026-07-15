/** DTOs de los endpoints OPS. */
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AdminRole } from '@veo/shared-types';

const TRIP_STATUSES = [
  'REQUESTED',
  'MATCHING',
  'ASSIGNED',
  'ACCEPTED',
  'ARRIVING',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

export class ListTripsQueryDto {
  @IsOptional()
  @IsIn(TRIP_STATUSES)
  status?: (typeof TRIP_STATUSES)[number];

  @IsOptional()
  @IsString()
  driverId?: string;

  @IsOptional()
  @IsString()
  passengerId?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ListDriversQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** POST /ops/drivers/:id/reject → body. Motivo OPCIONAL del rechazo (lo verá el conductor en su app). */
export class RejectDriverDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** POST /ops/drivers/:id/suspend → body. Motivo OBLIGATORIO de la suspensión (SAFETY · queda en auditoría). */
export class SuspendDriverDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class CreateOperatorDto {
  @IsEmail()
  email!: string;

  @IsArray()
  @IsIn(Object.values(AdminRole), { each: true })
  roles!: AdminRole[];
}

/** POST /ops/operators/:id/roles → body. Reemplaza los roles RBAC del operador (≥1, todos AdminRole válidos). */
export class ChangeOperatorRolesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(Object.values(AdminRole), { each: true })
  roles!: AdminRole[];
}
