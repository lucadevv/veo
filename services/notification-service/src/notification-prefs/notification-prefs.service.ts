/**
 * NotificationPrefsService — lee/escribe las preferencias in-app del usuario. GET nunca 404ea: si el
 * usuario no guardó nada devuelve los DEFAULTS canónicos (las preferencias SIEMPRE tienen un valor).
 * PUT reemplaza el objeto completo (idempotente). Observabilidad §6: log estructurado por operación.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationPreferenceRepository,
  type NotificationPrefsInput,
} from './notification-prefs.repository';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefsView } from './dto/notification-prefs.dto';
import type { NotificationPreference } from '../generated/prisma';

@Injectable()
export class NotificationPrefsService {
  private readonly logger = new Logger(NotificationPrefsService.name);

  constructor(private readonly repo: NotificationPreferenceRepository) {}

  /** Preferencias efectivas del usuario (fila guardada o defaults si nunca guardó). */
  async get(userId: string): Promise<NotificationPrefsView> {
    const row = await this.repo.findByUser(userId);
    return row ? NotificationPrefsService.toView(row) : { ...DEFAULT_NOTIFICATION_PREFS };
  }

  /** Reemplaza el objeto completo de preferencias del usuario y devuelve el estado persistido. */
  async put(userId: string, prefs: NotificationPrefsInput): Promise<NotificationPrefsView> {
    const row = await this.repo.upsert(userId, prefs);
    this.logger.log(`Preferencias de notificación actualizadas (user=${userId})`);
    return NotificationPrefsService.toView(row);
  }

  private static toView(row: NotificationPreference): NotificationPrefsView {
    return {
      tripStatus: row.tripStatus,
      driverEnRoute: row.driverEnRoute,
      scheduledReminders: row.scheduledReminders,
      offers: row.offers,
      news: row.news,
    };
  }
}
