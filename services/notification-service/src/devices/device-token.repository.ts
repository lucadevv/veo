/**
 * DeviceTokenRepository — almacén de tokens de push por dispositivo (upsert idempotente por token).
 * El productor de notificaciones resuelve aquí los destinatarios cuando el evento no trae token.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import type { DevicePlatform } from '../generated/prisma';

/** Token de push con su plataforma de envío (FCM/APNs). */
export interface DeviceTarget {
  token: string;
  platform: DevicePlatform;
}

@Injectable()
export class DeviceTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Alta/actualización idempotente por token (un mismo token puede cambiar de dueño/plataforma). */
  async upsert(input: { userId: string; token: string; platform: DevicePlatform }): Promise<void> {
    await this.prisma.write.deviceToken.upsert({
      where: { token: input.token },
      create: { userId: input.userId, token: input.token, platform: input.platform },
      update: { userId: input.userId, platform: input.platform },
    });
  }

  /** Baja por token (idempotente: no falla si no existe). */
  async deleteByToken(token: string): Promise<void> {
    await this.prisma.write.deviceToken.deleteMany({ where: { token } });
  }

  /** Devuelve los dispositivos activos de un usuario (más recientes primero). */
  findActiveByUser(userId: string): Promise<DeviceTarget[]> {
    return this.prisma.read.deviceToken.findMany({
      where: { userId },
      select: { token: true, platform: true },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
