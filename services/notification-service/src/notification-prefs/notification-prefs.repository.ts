/**
 * NotificationPreferenceRepository — almacén de preferencias in-app por usuario. `userId` lo fija el
 * llamante desde la identidad firmada; nunca del cuerpo. Ausencia de fila = defaults (el servicio los
 * resuelve). `upsert` reemplaza el objeto completo (PUT idempotente).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import type { NotificationPreference } from '../generated/prisma';

/** Los 5 booleans de preferencias (sin metadatos). */
export interface NotificationPrefsInput {
  tripStatus: boolean;
  driverEnRoute: boolean;
  scheduledReminders: boolean;
  offers: boolean;
  news: boolean;
}

@Injectable()
export class NotificationPreferenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Fila del usuario o `null` si nunca guardó preferencias (el servicio devuelve defaults). */
  findByUser(userId: string): Promise<NotificationPreference | null> {
    return this.prisma.read.notificationPreference.findUnique({ where: { userId } });
  }

  /** Crea o reemplaza (PUT) el objeto completo de preferencias del usuario. */
  upsert(userId: string, prefs: NotificationPrefsInput): Promise<NotificationPreference> {
    return this.prisma.write.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...prefs },
      update: { ...prefs },
    });
  }

  /**
   * Derecho al olvido (Ley 29733, BR-S06): borra las preferencias del usuario. Idempotente
   * (deleteMany no-op si ya no hay fila). Devuelve cuántas borró (0 o 1).
   */
  async deleteByUser(userId: string): Promise<number> {
    const { count } = await this.prisma.write.notificationPreference.deleteMany({
      where: { userId },
    });
    return count;
  }
}
