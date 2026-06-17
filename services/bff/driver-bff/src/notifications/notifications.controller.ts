/**
 * Notificaciones del conductor. JWT de tipo 'driver'. Siempre filtradas al usuario autenticado.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DriverApi } from '../common/driver-api.decorator';
import { NotificationsService } from './notifications.service';
import { RegisterDeviceTokenDto } from './dto/device-token.dto';

@ApiTags('notifications')
@DriverApi()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar las notificaciones del conductor autenticado' })
  @ApiQuery({ name: 'limit', required: false })
  list(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string): Promise<unknown> {
    const parsed = limit ? Number(limit) : undefined;
    return this.notifications.listMine(user, Number.isFinite(parsed) ? parsed : undefined);
  }

  @Post('device-token')
  @HttpCode(204)
  @ApiOperation({ summary: 'Registrar el token de push del conductor' })
  registerDeviceToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceTokenDto,
  ): Promise<void> {
    return this.notifications.registerDeviceToken(user, dto);
  }

  @Delete('device-token/:token')
  @HttpCode(204)
  @ApiOperation({ summary: 'Eliminar un token de push del conductor' })
  removeDeviceToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ): Promise<void> {
    return this.notifications.removeDeviceToken(user, token);
  }
}
