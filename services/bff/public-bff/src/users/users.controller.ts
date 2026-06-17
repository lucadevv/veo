import { Body, Controller, Delete, Get, HttpCode, Ip, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { RateLimit } from '../ratelimit/rate-limit.decorator';
import { UsersService } from './users.service';
import { UpdateProfileDto, type UserProfile } from './dto/update-profile.dto';
import {
  PresignAvatarUploadDto,
  ConfirmAvatarUploadDto,
  type AvatarUploadTicket,
  type AvatarUploadConfirmed,
} from './dto/presign-avatar.dto';
import { RecordConsentDto, type ConsentRecorded } from './dto/record-consent.dto';
import { RequestPhoneLinkDto, VerifyPhoneLinkDto } from './dto/phone-link.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Perfil del usuario autenticado' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<UserProfile> {
    return this.users.getProfile(user);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Actualizar perfil (nombre, email, foto)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserProfile> {
    return this.users.updateProfile(user, dto);
  }

  @Post('me/avatar/presign')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Presign de subida del avatar (PUT directo a S3/MinIO vía media-service)',
  })
  presignAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PresignAvatarUploadDto,
  ): Promise<AvatarUploadTicket> {
    return this.users.presignAvatarUpload(user, dto);
  }

  @Post('me/avatar/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmar la subida del avatar y validar la cuota de tamaño' })
  confirmAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmAvatarUploadDto,
  ): Promise<AvatarUploadConfirmed> {
    return this.users.confirmAvatarUpload(user, dto);
  }

  @Get('me/consents')
  @ApiOperation({
    summary: 'Consentimiento VIGENTE del pasajero (el más reciente; null si nunca registró)',
  })
  currentConsent(@CurrentUser() user: AuthenticatedUser): Promise<ConsentRecorded | null> {
    return this.users.getCurrentConsent(user);
  }

  @Post('me/consents')
  @HttpCode(201)
  @ApiOperation({ summary: 'Registrar un consentimiento del pasajero (Ley 29733, append-only)' })
  recordConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RecordConsentDto,
    @Ip() ip: string,
  ): Promise<ConsentRecorded> {
    return this.users.recordConsent(
      user,
      {
        dataProcessing: dto.dataProcessing,
        inCabinCamera: dto.inCabinCamera,
        location: dto.location,
        marketing: dto.marketing,
        policyVersion: dto.policyVersion,
        dedupKey: dto.dedupKey,
      },
      ip || null,
    );
  }

  @Post('me/phone/request')
  @HttpCode(200)
  // Borde anti-flood SMS de vinculación: 5 cada 10min por usuario+teléfono+IP (autenticado).
  @RateLimit({ max: 5, windowMs: 10 * 60_000, by: ['user', 'phone', 'ip'] })
  @ApiOperation({ summary: 'Solicitar OTP para vincular un teléfono al perfil' })
  requestPhoneLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestPhoneLinkDto,
  ): Promise<{ sent: true }> {
    return this.users.requestPhoneLink(user, dto);
  }

  @Post('me/phone/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verificar el OTP y vincular el teléfono (devuelve el perfil)' })
  verifyPhoneLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyPhoneLinkDto,
  ): Promise<UserProfile> {
    return this.users.verifyPhoneLink(user, dto);
  }

  @Post('me/deletion')
  @HttpCode(202)
  @ApiOperation({ summary: 'Solicitar borrado de cuenta (derecho al olvido)' })
  requestDeletion(@CurrentUser() user: AuthenticatedUser): Promise<{ graceUntil: string }> {
    return this.users.requestDeletion(user);
  }

  @Delete('me/deletion')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancelar la solicitud de borrado' })
  cancelDeletion(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.users.cancelDeletion(user);
  }
}
