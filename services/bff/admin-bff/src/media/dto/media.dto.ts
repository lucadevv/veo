/** DTOs de acceso a video (doble-auth). */
import { IsEmail, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class RequestAccessDto {
  @IsUUID()
  tripId!: string;

  @IsOptional()
  @IsUUID()
  segmentId?: string;

  @IsEmail()
  operatorEmail!: string;

  /** Motivo de la solicitud (media-service exige > 20 caracteres). */
  @IsString()
  @MinLength(21)
  reason!: string;
}

export class SegmentsQueryDto {
  @IsUUID()
  tripId!: string;
}

/** Acceso a la cámara EN VIVO (muro admin). Motivo obligatorio (auditado). La identidad del operador NO
 *  se confía al cliente: la deriva el bff de la sesión autenticada. Doble-auth (Roles + MFA fresca) en el controller. */
export class LiveAccessDto {
  @IsUUID()
  tripId!: string;

  /** Motivo del visionado en vivo (> 20 caracteres), igual que las grabaciones. Queda en la pista de audit. */
  @IsString()
  @MinLength(21)
  reason!: string;
}
