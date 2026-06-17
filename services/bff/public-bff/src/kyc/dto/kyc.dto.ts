import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** Un frame capturado por la cámara de la app durante el reto de liveness. */
export class KycFrameDto {
  @ApiProperty({ description: 'JPEG del frame codificado en base64 (sin prefijo data URI)' })
  @IsString()
  base64Jpeg!: string;

  // width/height son metadata OPCIONAL: nada aguas abajo los consume (el bff aplana los frames a
  // base64[] y el biometric-service decodifica el JPEG por su cuenta). El frame-grabber nativo solo
  // devuelve base64, así que no se exigen.
  @ApiProperty({ example: 640, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @ApiProperty({ example: 480, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  @ApiProperty({ description: 'Epoch ms en que se capturó el frame', example: 1717000000000 })
  @IsNumber()
  capturedAt!: number;
}

export class VerifyKycDto {
  @ApiProperty({
    description: 'Identificador del reto de liveness emitido por POST /kyc/challenge',
  })
  @IsString()
  challengeId!: string;

  @ApiProperty({ type: [KycFrameDto], description: 'Frames del reto en orden temporal' })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => KycFrameDto)
  frames!: KycFrameDto[];
}

/** Reto de liveness reexpuesto a la app (contrato externo). */
export interface KycChallengeView {
  challengeId: string;
  action: string;
  instructions: string;
  expiresAt: string;
}

/** Resultado de la verificación reexpuesto a la app (contrato externo). */
export interface KycVerificationView {
  status: 'VERIFIED' | 'REJECTED';
  verificationId: string;
  reason?: string;
}
