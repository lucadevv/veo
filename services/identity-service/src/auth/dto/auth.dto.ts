import { IsIn, IsNotEmpty, IsString, Length, Matches } from 'class-validator';
import { type ActorType, ACTOR_TYPES } from '@veo/shared-types';

export class RequestOtpDto {
  @IsString()
  @Matches(/^\+?(?:51)?9\d{8}$/, { message: 'Teléfono peruano inválido' })
  phone!: string;

  @IsIn(ACTOR_TYPES)
  type!: ActorType;
}

export class VerifyOtpDto {
  @IsString()
  @Matches(/^\+?(?:51)?9\d{8}$/, { message: 'Teléfono peruano inválido' })
  phone!: string;

  @IsString()
  @Length(6, 6, { message: 'El OTP tiene 6 dígitos' })
  code!: string;

  @IsIn(ACTOR_TYPES)
  type!: ActorType;
}

/** Login con Google OAuth (ADR-012 Lote 3): el cliente manda el id_token; lo verificamos server-side. */
export class GoogleOAuthDto {
  @IsString()
  @IsNotEmpty({ message: 'idToken requerido' })
  idToken!: string;
}

/**
 * Login con Apple (Sign in with Apple, App Store Guideline 4.8): el cliente manda el identityToken
 * del flujo nativo; lo verificamos server-side contra el JWKS de Apple.
 */
export class AppleOAuthDto {
  @IsString()
  @IsNotEmpty({ message: 'identityToken requerido' })
  identityToken!: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class LogoutDto {
  @IsString()
  refreshToken!: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string | null; type: string; kycStatus: string; email?: string | null };
}
