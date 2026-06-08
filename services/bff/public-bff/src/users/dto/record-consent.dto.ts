import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * POST /users/me/consents → body. Aceptación de consentimientos del pasajero (Ley 29733).
 * El BFF añade la IP del request al proxyar a identity-service; no se acepta del cliente.
 */
export class RecordConsentDto {
  @ApiProperty({ description: 'Tratamiento de datos personales (base legal del servicio)' })
  @IsBoolean()
  dataProcessing!: boolean;

  @ApiProperty({ description: 'Cámara en vivo del habitáculo durante el viaje' })
  @IsBoolean()
  inCabinCamera!: boolean;

  @ApiProperty({ description: 'Compartir ubicación con contactos de confianza' })
  @IsBoolean()
  location!: boolean;

  @ApiProperty({ description: 'Aceptar comunicaciones de marketing/promociones (opt-in)' })
  @IsBoolean()
  marketing!: boolean;

  @ApiProperty({ description: 'Versión de la política de privacidad aceptada' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  policyVersion!: string;
}

/** Datos que el servicio reenvía a identity-service (sin la ip, que añade el BFF). */
export interface RecordConsentInput {
  dataProcessing: boolean;
  inCabinCamera: boolean;
  location: boolean;
  marketing: boolean;
  policyVersion: string;
}

/** Consentimiento (append-only). Respuesta de POST (201) y de GET (vigente; `null` si nunca registró). */
export interface ConsentRecorded {
  id: string;
  userId: string;
  dataProcessing: boolean;
  inCabinCamera: boolean;
  location: boolean;
  marketing: boolean;
  policyVersion: string;
  acceptedAt: string;
}
