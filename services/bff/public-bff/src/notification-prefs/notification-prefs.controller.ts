import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@veo/auth';
import type { NotificationPrefs } from '@veo/api-client';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationPrefsDto } from './dto/notification-prefs.dto';

@ApiTags('notification-prefs')
@ApiBearerAuth()
@Controller('notification-prefs')
export class NotificationPrefsController {
  constructor(private readonly prefs: NotificationPrefsService) {}

  @Get()
  @ApiOperation({ summary: 'Mis preferencias de notificación (defaults si nunca guardé)' })
  get(@CurrentUser() user: AuthenticatedUser): Promise<NotificationPrefs> {
    return this.prefs.get(user);
  }

  @Put()
  @ApiOperation({ summary: 'Reemplazar mis preferencias de notificación (idempotente)' })
  put(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: NotificationPrefsDto,
  ): Promise<NotificationPrefs> {
    return this.prefs.put(user, dto);
  }
}
