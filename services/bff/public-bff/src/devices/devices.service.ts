/**
 * Registro de tokens de push del pasajero. Reenvía a notification-service con identidad interna
 * firmada (el userId se resuelve allí desde el header). El BFF no almacena nada.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import { REST_NOTIFICATION } from '../infra/downstream.tokens';
import type { RegisterDeviceDto } from './dto/device.dto';

@Injectable()
export class DevicesService {
  constructor(@Inject(REST_NOTIFICATION) private readonly notification: InternalRestClient) {}

  register(user: AuthenticatedUser, dto: RegisterDeviceDto): Promise<void> {
    return this.notification.post<void>('/internal/devices', { identity: user, body: dto });
  }

  unregister(user: AuthenticatedUser, token: string): Promise<void> {
    return this.notification.delete<void>(`/internal/devices/${encodeURIComponent(token)}`, {
      identity: user,
    });
  }
}
