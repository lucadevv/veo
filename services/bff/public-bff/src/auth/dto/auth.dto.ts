import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { ActorType, ACTOR_TYPES } from '@veo/shared-types';

/**
 * Tipo de actor reenviado a identity en los flujos OTP de ESTE BFF. El public-bff es el BFF del
 * PASAJERO: NUNCA emite OTP de conductor. Por eso el `type` se fija server-side a passenger y NO se
 * acepta del cliente (defensa en profundidad: el JWT guard cierra las rutas protegidas, pero el login
 * del propio BFF también se acota). Constante tipada del dominio — sin string mágico.
 */
export const OTP_ACTOR_TYPE: ActorType = ActorType.PASSENGER;

/** Teléfono peruano (formato BR-I06): 9XXXXXXXX, opcionalmente con prefijo de país 51/+51. */
const PERU_PHONE = /^\+?(?:51)?9\d{8}$/;

/** Versión del mensaje canónico de la firma de pánico (debe coincidir con panic-service). */
export const PANIC_SIGNATURE_VERSION = 'panic.trigger:v1';

/**
 * El `type` del OTP NO se acepta del cliente: el service lo fija a {@link OTP_ACTOR_TYPE} (passenger).
 * Un payload con `type` se descarta por el whitelist del ValidationPipe (no se reenvía a identity).
 */
export class RequestOtpDto {
  @IsString()
  @Matches(PERU_PHONE, { message: 'Teléfono peruano inválido' })
  phone!: string;
}

/** Igual que {@link RequestOtpDto}: el `type` se fija server-side a passenger, no llega del cliente. */
export class VerifyOtpDto {
  @IsString()
  @Matches(PERU_PHONE, { message: 'Teléfono peruano inválido' })
  phone!: string;

  @IsString()
  @Length(6, 6, { message: 'El OTP tiene 6 dígitos' })
  code!: string;
}

/**
 * DTOs de auth por correo + contraseña (ADR-012). El public-bff valida el borde y reenvía a
 * identity-service (@Public). Mínimo de contraseña 12 (ADR-012 §4); el rechazo de contraseñas
 * triviales lo hace identity (400 VALIDATION), no acá.
 */
const EMAIL_PASSWORD_MIN = 12;

export class RegisterEmailDto {
  @IsEmail({}, { message: 'Correo inválido' })
  email!: string;

  @IsString()
  @MinLength(EMAIL_PASSWORD_MIN, { message: 'La contraseña debe tener al menos 12 caracteres' })
  password!: string;

  @IsOptional()
  @IsString()
  @Length(1, 80, { message: 'El nombre debe tener entre 1 y 80 caracteres' })
  name?: string;

  @IsIn(ACTOR_TYPES)
  type!: ActorType;
}

export class VerifyEmailDto {
  @IsEmail({}, { message: 'Correo inválido' })
  email!: string;

  @IsString()
  @Length(6, 6, { message: 'El código tiene 6 dígitos' })
  code!: string;
}

export class LoginEmailDto {
  @IsEmail({}, { message: 'Correo inválido' })
  email!: string;

  @IsString()
  @MinLength(1, { message: 'Contraseña requerida' })
  password!: string;
}

export class ResendEmailDto {
  @IsEmail({}, { message: 'Correo inválido' })
  email!: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Correo inválido' })
  email!: string;
}

export class ResetPasswordDto {
  @IsEmail({}, { message: 'Correo inválido' })
  email!: string;

  @IsString()
  @Length(6, 6, { message: 'El código tiene 6 dígitos' })
  code!: string;

  @IsString()
  @MinLength(EMAIL_PASSWORD_MIN, { message: 'La contraseña debe tener al menos 12 caracteres' })
  newPassword!: string;
}

/** Login con Google OAuth (ADR-012 Lote 3): passthrough del id_token a identity (que lo verifica). */
export class GoogleOAuthDto {
  @IsString()
  @IsNotEmpty({ message: 'idToken requerido' })
  idToken!: string;
}

/**
 * Login con Apple (Sign in with Apple, App Store Guideline 4.8): passthrough del identityToken a
 * identity (que lo verifica contra el JWKS de Apple server-side).
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

/**
 * Respuesta de verificación/login: tokens + datos mínimos del usuario.
 * `phone` es nullable y `email` opcional: el alta por correo (ADR-012) crea la cuenta sin teléfono.
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    phone: string | null;
    type: string;
    kycStatus: string;
    email?: string | null;
  };
}

/** Confirmación de envío de código (register/forgot). */
export interface EmailSentResult {
  sent: true;
}

/** Confirmación de operación (reset). */
export interface EmailOkResult {
  ok: true;
}

/** Secreto HMAC compartido de pánico + versión del mensaje canónico. */
export interface PanicKey {
  secret: string;
  version: string;
}
