import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';

/** Mínimo 12 chars (ADR-012 §4). El chequeo de "no trivial" se hace en el servicio. */
const PASSWORD_MIN = 12;

export class RegisterEmailDto {
  @IsEmail({}, { message: 'Correo inválido' })
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN, { message: 'La contraseña debe tener al menos 12 caracteres' })
  password!: string;

  @IsOptional()
  @IsString()
  @Length(1, 80, { message: 'El nombre debe tener entre 1 y 80 caracteres' })
  name?: string;

  @IsIn(['PASSENGER', 'DRIVER'])
  type!: 'PASSENGER' | 'DRIVER';
}

export class VerifyEmailDto {
  @IsEmail({}, { message: 'Correo inválido' })
  email!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'El código tiene 6 dígitos' })
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
  @Matches(/^\d{6}$/, { message: 'El código tiene 6 dígitos' })
  code!: string;

  @IsString()
  @MinLength(PASSWORD_MIN, { message: 'La contraseña debe tener al menos 12 caracteres' })
  newPassword!: string;
}
