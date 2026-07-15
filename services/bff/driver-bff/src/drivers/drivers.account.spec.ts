/**
 * Tests de CUENTA del conductor en el driver-bff (cambio de teléfono + derecho al olvido):
 *  - los 4 endpoints PROXEAN firmado al motor de identity (`/users/me/*`, abierto al riel DRIVER);
 *  - el userId viaja SOLO en la identidad propagada (anti-IDOR): el body lleva únicamente phone/code;
 *  - verifyPhoneChange PROYECTA el ProfileView de identity a `{ phone }` (no filtra el shape passenger);
 *  - phone/request lleva el rate-limit espejo del public-bff (anti-flood SMS, 5/10min user+phone+ip).
 */
import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '@veo/auth';
import { DriversService } from './drivers.service';
import { DriversController } from './drivers.controller';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../common/guards/rate-limit.decorator';

const identity: AuthenticatedUser = { userId: 'usr-1', type: 'driver', roles: [], sessionId: 's1' };

/** ProfileView COMPLETO que devuelve identity (shape del pasajero) — el BFF debe proyectarlo. */
const IDENTITY_PROFILE = {
  id: 'usr-1',
  phone: '+51999888777',
  email: null,
  name: 'Carlos',
  type: 'DRIVER',
  kycStatus: 'VERIFIED',
  photoUrl: null,
  documentType: null,
  document: null,
  defaultPaymentMethod: null,
  deletionRequestedAt: null,
};

function makeService(reply: unknown = undefined) {
  const identityPost = vi.fn(() => Promise.resolve(reply));
  const identityDelete = vi.fn(() => Promise.resolve(undefined));
  const clients: Record<string, unknown> = {
    identity: { post: identityPost, get: vi.fn(), patch: vi.fn(), delete: identityDelete },
  };
  const rest = { client: vi.fn((service: string) => clients[service]) };
  const grpc = { call: vi.fn() };
  const activeVehicleType = { invalidate: vi.fn(), resolve: vi.fn() };
  const config = {
    getOrThrow: vi.fn((key: string) => (key === 'S3_BUCKET_DOCUMENTS' ? 'veo-documents-dev' : 300)),
  };
  const service = new DriversService(
    grpc as never,
    rest as never,
    activeVehicleType as never,
    config as never,
  );
  return { service, identityPost, identityDelete };
}

describe('DriversService cuenta (driver-bff) — phone-link + derecho al olvido', () => {
  it('requestPhoneChange PROXYA a identity con la identidad propagada y SOLO el phone en el body', async () => {
    const { service, identityPost } = makeService({ sent: true });

    const result = await service.requestPhoneChange(identity, { phone: '999888777' });

    expect(identityPost).toHaveBeenCalledWith('/users/me/phone/request', {
      identity,
      body: { phone: '999888777' },
    });
    expect(result).toEqual({ sent: true });
  });

  it('verifyPhoneChange manda phone+code y PROYECTA el ProfileView a { phone } (sin campos passenger)', async () => {
    const { service, identityPost } = makeService(IDENTITY_PROFILE);

    const result = await service.verifyPhoneChange(identity, {
      phone: '999888777',
      code: '123456',
    });

    expect(identityPost).toHaveBeenCalledWith('/users/me/phone/verify', {
      identity,
      body: { phone: '999888777', code: '123456' },
    });
    // Proyección estricta: el conductor solo recibe el teléfono nuevo (su próximo login).
    expect(result).toEqual({ phone: '+51999888777' });
  });

  it('requestAccountDeletion PROXYA el POST de borrado y devuelve el fin de la gracia', async () => {
    const graceUntil = '2026-08-14T00:00:00.000Z';
    const { service, identityPost } = makeService({ graceUntil });

    const result = await service.requestAccountDeletion(identity);

    expect(identityPost).toHaveBeenCalledWith('/users/me/deletion', { identity, body: {} });
    expect(result).toEqual({ graceUntil });
  });

  it('cancelAccountDeletion PROXYA el DELETE con la identidad propagada', async () => {
    const { service, identityDelete } = makeService();

    await service.cancelAccountDeletion(identity);

    expect(identityDelete).toHaveBeenCalledWith('/users/me/deletion', { identity });
  });
});

describe('DriversController cuenta — rate-limit del cambio de número (espejo del public-bff)', () => {
  it('me/phone/request lleva @RateLimit 5/10min por user+phone+ip (anti-flood SMS)', () => {
    const reflector = new Reflector();
    const opts = reflector.get<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      DriversController.prototype.requestPhoneChange,
    );
    expect(opts).toEqual({ max: 5, windowMs: 600_000, by: ['user', 'phone', 'ip'] });
  });

  it('me/phone/verify y me/deletion NO llevan override (rigen el cap global + el lockout de identity)', () => {
    const reflector = new Reflector();
    for (const handler of [
      DriversController.prototype.verifyPhoneChange,
      DriversController.prototype.requestDeletion,
      DriversController.prototype.cancelDeletion,
    ]) {
      expect(reflector.get(RATE_LIMIT_KEY, handler)).toBeUndefined();
    }
  });
});
