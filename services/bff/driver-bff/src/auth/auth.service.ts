/**
 * Passthrough de autenticación del conductor hacia identity-service (endpoints @Public).
 * El tipo de sujeto se fuerza a 'driver': este BFF nunca emite tokens de pasajero/admin.
 */
import { Injectable } from '@nestjs/common';
import { RestGateway } from '../infra/rest.gateway';
import { ANONYMOUS_DRIVER_IDENTITY } from '../common/identities';
import type { AuthTokens } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(private readonly rest: RestGateway) {}

  requestOtp(phone: string): Promise<{ sent: true }> {
    // identity exige `type` (PASSENGER|DRIVER en mayúsculas). Este BFF siempre es DRIVER.
    return this.identity().post<{ sent: true }>('/auth/otp/request', {
      identity: ANONYMOUS_DRIVER_IDENTITY,
      body: { phone, type: 'DRIVER' },
    });
  }

  verifyOtp(phone: string, code: string): Promise<AuthTokens> {
    return this.identity().post<AuthTokens>('/auth/otp/verify', {
      identity: ANONYMOUS_DRIVER_IDENTITY,
      body: { phone, code, type: 'DRIVER' },
    });
  }

  refresh(refreshToken: string): Promise<AuthTokens> {
    return this.identity().post<AuthTokens>('/auth/refresh', {
      identity: ANONYMOUS_DRIVER_IDENTITY,
      body: { refreshToken },
    });
  }

  logout(refreshToken: string): Promise<{ ok: true }> {
    return this.identity().post<{ ok: true }>('/auth/logout', {
      identity: ANONYMOUS_DRIVER_IDENTITY,
      body: { refreshToken },
    });
  }

  logoutAll(refreshToken: string): Promise<{ ok: true }> {
    return this.identity().post<{ ok: true }>('/auth/logout-all', {
      identity: ANONYMOUS_DRIVER_IDENTITY,
      body: { refreshToken },
    });
  }

  private identity() {
    return this.rest.client('identity');
  }
}
