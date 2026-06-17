import { Body, Controller, Delete, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { PaymentMethod } from '@veo/shared-types';
import { DOCUMENT_TYPES, IsValidDocument, type DocumentTypeValue } from '../common/document';
import { UsersService, type ProfileView } from './users.service';
import { PhoneLinkService } from './phone-link.service';
import { RequestPhoneLinkDto, VerifyPhoneLinkDto } from './dto/phone-link.dto';

class UpdateProfileDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsUrl()
  @IsString()
  photoUrl?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  /**
   * Tipo de documento del pasajero (DN|CE|PP). Vive en el PERFIL para la afiliación Yape de UN TAP.
   * Va siempre acompañado de `document`; sin él, no se valida la forma. Opcional: si no viene, no se toca.
   */
  @IsOptional()
  @IsEnum(Object.fromEntries(DOCUMENT_TYPES.map((d) => [d, d])), {
    message: 'documentType debe ser DN, CE o PP',
  })
  documentType?: DocumentTypeValue;

  /**
   * Número de documento. Se valida SEGÚN `documentType` (DN=8 díg · CE 9-12 díg · PP 6-12 alfanum).
   * Requiere `documentType` presente (sin él, la validación falla). Opcional: si no viene, no se toca.
   */
  @IsOptional()
  @IsValidDocument()
  document?: string;

  /**
   * Método de pago por defecto del pasajero (preferencia de UI: siembra el selector al pedir viaje).
   * Validado contra el enum compartido PaymentMethod (YAPE|PLIN|CASH|CARD|PAGOEFECTIVO). Opcional: si
   * no viene, no se toca.
   */
  @IsOptional()
  @IsEnum(PaymentMethod)
  defaultPaymentMethod?: PaymentMethod;
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly phoneLink: PhoneLinkService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Perfil del usuario autenticado' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<ProfileView> {
    return this.users.getProfile(user.userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Actualizar perfil (email, foto, nombre)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileView> {
    return this.users.updateProfile(user.userId, dto);
  }

  @Post('me/phone/request')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Solicitar OTP para vincular un teléfono al perfil (reusa la infra OTP del login)',
  })
  requestPhoneLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestPhoneLinkDto,
  ): Promise<{ sent: true }> {
    return this.phoneLink.request(user.userId, dto.phone);
  }

  @Post('me/phone/verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verificar el OTP y vincular el teléfono al perfil (devuelve el perfil)',
  })
  verifyPhoneLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyPhoneLinkDto,
  ): Promise<ProfileView> {
    return this.phoneLink.verify(user.userId, dto.phone, dto.code);
  }

  @Post('me/deletion')
  @HttpCode(202)
  @ApiOperation({ summary: 'Solicitar borrado de cuenta (derecho al olvido, gracia 30 días)' })
  requestDeletion(@CurrentUser() user: AuthenticatedUser): Promise<{ graceUntil: string }> {
    return this.users.requestDeletion(user.userId);
  }

  @Delete('me/deletion')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancelar la solicitud de borrado (dentro de la gracia)' })
  async cancelDeletion(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.users.cancelDeletion(user.userId);
  }
}
