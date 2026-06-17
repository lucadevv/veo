/** DTOs de acceso a video (doble-auth). */
import { IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

/**
 * Estados del ciclo de vida de una solicitud de acceso a video (contrato compartido con media-service
 * y validado por el schema Zod del cliente). Es la ÚNICA fuente de los literales — prohibido el string mágico.
 */
export const VIDEO_ACCESS_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type VideoAccessStatus = (typeof VIDEO_ACCESS_STATUSES)[number];

export class RequestAccessDto {
  @IsUUID()
  tripId!: string;

  /** Motivo de la solicitud (media-service exige > 20 caracteres). */
  @IsString()
  @MinLength(21)
  reason!: string;
}

/** Filtro opcional del listado de solicitudes por estado del ciclo de vida. */
export class AccessRequestsQueryDto {
  @IsOptional()
  @IsIn(VIDEO_ACCESS_STATUSES)
  status?: VideoAccessStatus;
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
