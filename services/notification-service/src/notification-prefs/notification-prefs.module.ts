import { Module } from '@nestjs/common';
import { NotificationPrefsController } from './notification-prefs.controller';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationPreferenceRepository } from './notification-prefs.repository';

/**
 * Preferencias in-app de notificaciones. Vive en notification-service (bounded context de
 * comunicaciones con el usuario): reusa su Postgres, Prisma y el InternalIdentityGuard. El repositorio
 * se exporta para el borrado del derecho al olvido (UserDeletedConsumer).
 */
@Module({
  controllers: [NotificationPrefsController],
  providers: [NotificationPrefsService, NotificationPreferenceRepository],
  exports: [NotificationPreferenceRepository],
})
export class NotificationPrefsModule {}
