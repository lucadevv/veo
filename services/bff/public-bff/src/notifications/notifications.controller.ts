import { Controller, Get, HttpCode, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { NotificationsService } from './notifications.service';
import type { AppNotificationView, MarkAllReadResultView } from './dto/notification.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Bandeja in-app del pasajero: SUS notificaciones PUSH renderizadas (título + cuerpo), más ' +
      'recientes primero. El recipientId sale del JWT (anti-IDOR), nunca del cliente.',
  })
  @ApiQuery({ name: 'limit', required: false })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ): Promise<AppNotificationView[]> {
    return this.notifications.list(user, limit ? Number(limit) : undefined);
  }

  @Patch('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marcar TODAS mis notificaciones como leídas (owner del JWT)' })
  markAllRead(@CurrentUser() user: AuthenticatedUser): Promise<MarkAllReadResultView> {
    return this.notifications.markAllRead(user);
  }

  @Patch(':id/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Marcar UNA notificación como leída (owner del JWT; anti-IDOR)' })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.notifications.markRead(user, id);
  }
}
