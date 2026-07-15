/**
 * Notificaciones del conductor. JWT de tipo 'driver'. Siempre filtradas al usuario autenticado.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { DriverApi } from '../common/driver-api.decorator';
import { NotificationsService, type MarkAllReadResultView } from './notifications.service';
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

  // 'read-all' se declara ANTES de ':id/read' por higiene de rutas (mismo criterio que
  // notification-service). El dueño lo deriva el downstream de la identidad firmada, nunca del path.
  @Patch('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marcar TODOS mis avisos como leídos (owner del JWT)' })
  markAllRead(@CurrentUser() user: AuthenticatedUser): Promise<MarkAllReadResultView> {
    return this.notifications.markAllRead(user);
  }

  @Patch(':id/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Marcar UN aviso como leído (owner del JWT; anti-IDOR)' })
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.notifications.markRead(user, id);
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
