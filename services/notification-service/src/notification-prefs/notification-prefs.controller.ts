/**
 * Preferencias in-app de notificaciones (interno). Protegido por InternalIdentityGuard: el BFF público
 * propaga la identidad firmada del pasajero; el `userId` se toma de ahí (NUNCA del cuerpo: anti-IDOR).
 *  - GET /notification-prefs → mis preferencias (defaults si nunca guardé).
 *  - PUT /notification-prefs → reemplaza mis preferencias (idempotente).
 */
import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, InternalIdentityGuard, type AuthenticatedUser } from '@veo/auth';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationPrefsDto, type NotificationPrefsView } from './dto/notification-prefs.dto';

@ApiTags('notification-prefs')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('notification-prefs')
export class NotificationPrefsController {
  constructor(private readonly prefs: NotificationPrefsService) {}

  @Get()
  @ApiOperation({ summary: 'Mis preferencias de notificación (defaults si nunca guardé)' })
  get(@CurrentUser() user: AuthenticatedUser): Promise<NotificationPrefsView> {
    return this.prefs.get(user.userId);
  }

  @Put()
  @ApiOperation({ summary: 'Reemplazar mis preferencias de notificación (idempotente)' })
  put(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: NotificationPrefsDto,
  ): Promise<NotificationPrefsView> {
    return this.prefs.put(user.userId, dto);
  }
}
