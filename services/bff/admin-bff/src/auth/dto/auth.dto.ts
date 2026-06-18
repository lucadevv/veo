/** DTOs de los endpoints de auth del admin-bff (class-validator). */
import { IsEmail, IsOptional, IsString, Length, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(10)
  password!: string;

  /** TOTP de 6 dígitos si el operador ya tiene MFA enrolado. */
  @IsOptional()
  @IsString()
  @Length(6, 6)
  totp?: string;
}

export class TotpConfirmDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(10)
  password!: string;

  @IsString()
  @Length(6, 6)
  totp!: string;
}

export class StepUpDto {
  @IsString()
  @Length(6, 6)
  totp!: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class LogoutDto {
  @IsString()
  refreshToken!: string;
}

export class AcceptInviteDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(10)
  password!: string;
}
