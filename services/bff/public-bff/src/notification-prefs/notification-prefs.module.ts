import { Module } from '@nestjs/common';
import { NotificationPrefsController } from './notification-prefs.controller';
import { NotificationPrefsService } from './notification-prefs.service';

/** Preferencias in-app de notificaciones del pasajero (proxy firmado al notification-service). */
@Module({
  controllers: [NotificationPrefsController],
  providers: [NotificationPrefsService],
})
export class NotificationPrefsModule {}
