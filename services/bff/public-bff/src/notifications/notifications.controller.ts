import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import { NotificationsService } from './notifications.service';
import type { AppNotificationView } from './dto/notification.dto';

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
}
