import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { AvatarService } from './avatar.service';
import {
  ConfirmAvatarUploadDto,
  PresignAvatarUploadDto,
  type AvatarUploadConfirmedView,
  type AvatarUploadTicketView,
} from './dto/avatar.dto';

@ApiTags('avatars')
@ApiBearerAuth()
@Controller('media/avatars')
export class AvatarController {
  constructor(private readonly avatars: AvatarService) {}

  /**
   * Emite un ticket de subida prefirmado (PUT) para el avatar del usuario autenticado. El cliente
   * sube el binario a `uploadUrl` y luego guarda `publicUrl` en su perfil (PATCH /users/me).
   */
  @UseGuards(InternalIdentityGuard)
  @Post('presign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generar URL prefirmada de subida del avatar (presigned PUT)' })
  presign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PresignAvatarUploadDto,
  ): Promise<AvatarUploadTicketView> {
    return this.avatars.createUploadTicket({
      userId: user.userId,
      contentType: dto.contentType,
      ext: dto.ext,
    });
  }

  /**
   * Confirma la subida: valida el tamaño real del objeto (cuota AVATAR_MAX_BYTES). Si excede el
   * límite, el servicio borra el objeto y responde 400; si cumple, devuelve la `publicUrl` estable.
   */
  @UseGuards(InternalIdentityGuard)
  @Post('confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmar la subida del avatar y validar la cuota de tamaño' })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmAvatarUploadDto,
  ): Promise<AvatarUploadConfirmedView> {
    return this.avatars.confirmUpload({ userId: user.userId, key: dto.key });
  }
}
