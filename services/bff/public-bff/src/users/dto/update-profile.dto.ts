import { IsEmail, IsEnum, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';
import { DocumentType } from '../../payments/dto/affiliations.dto';

export class UpdateProfileDto {
  // Nombre visible del pasajero (1–80). El downstream identity persiste null si no se envía nunca.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @IsUrl()
  photoUrl?: string;

  /**
   * Documento de identidad del pasajero para pagos (Yape On File). Vive en el perfil. El identity-service
   * re-valida la forma per-tipo. Opcional; va junto a `documentType`.
   */
  @IsOptional()
  @IsEnum(DocumentType, { message: 'documentType debe ser DN, CE o PP' })
  documentType?: DocumentType;

  @IsOptional()
  @IsString()
  document?: string;
}

/** Vista de perfil devuelta por identity-service. */
export interface UserProfile {
  id: string;
  phone: string;
  type: string;
  kycStatus: string;
  name: string | null;
  email: string | null;
  photoUrl: string | null;
  /** Documento del pasajero (Yape On File); null si aún no lo cargó. */
  documentType: DocumentType | null;
  document: string | null;
}
