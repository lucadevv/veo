/**
 * DevicesService — alta/baja de tokens de push. Sin lógica de entrega (vive en el motor).
 */
import { Injectable } from '@nestjs/common';
import { DeviceTokenRepository } from './device-token.repository';
import type { RegisterDeviceDto } from './dto/register-device.dto';

@Injectable()
export class DevicesService {
  constructor(private readonly repo: DeviceTokenRepository) {}

  register(userId: string, dto: RegisterDeviceDto): Promise<void> {
    return this.repo.upsert({ userId, token: dto.token, platform: dto.platform });
  }

  unregister(token: string): Promise<void> {
    return this.repo.deleteByToken(token);
  }
}
