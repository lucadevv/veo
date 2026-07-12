import { IsArray, IsEmail, IsIn, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { AdminRole } from '@veo/shared-types';

export class CreateOperatorDto {
  @IsEmail()
  email!: string;

  @IsArray()
  @IsIn(Object.values(AdminRole), { each: true })
  roles!: AdminRole[];
}

export class ChangeOperatorRolesDto {
  @IsArray()
  @IsIn(Object.values(AdminRole), { each: true })
  roles!: AdminRole[];
}

export class AcceptInviteDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(10, { message: 'La contraseña debe tener al menos 10 caracteres' })
  password!: string;
}

export class AdminLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  @Length(6, 6)
  totp?: string;
}

export class AdminEnrollConfirmDto {
  @IsEmail()
  email!: string;

  @IsString()
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
