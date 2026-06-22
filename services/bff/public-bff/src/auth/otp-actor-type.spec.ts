/**
 * FIX 3 (defensa en profundidad) — este es el BFF del PASAJERO: NUNCA emite OTP de conductor. El
 * `type` del OTP se FIJA server-side a passenger; lo que venga del cliente se ignora. Verificamos que
 * el body reenviado a identity siempre lleve type=PASSENGER, incluso si el caller inyecta type=DRIVER.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { InternalRestClient } from '@veo/rpc';
import { ActorType } from '@veo/shared-types';
import { AuthService } from './auth.service';
import { OTP_ACTOR_TYPE } from './dto/auth.dto';

function serviceWithCapture(): { service: AuthService; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const identity = {
    post: vi.fn(async (_path: string, opts: { body: Record<string, unknown> }) => {
      bodies.push(opts.body);
      return { sent: true };
    }),
  } as unknown as InternalRestClient;
  const config = { getOrThrow: () => 'x' } as unknown as ConfigService<never, true>;
  return { service: new AuthService(identity, config), bodies };
}

describe('AuthService · OTP type fijado a passenger', () => {
  it('la constante OTP_ACTOR_TYPE es PASSENGER (tipada, sin string mágico)', () => {
    expect(OTP_ACTOR_TYPE).toBe(ActorType.PASSENGER);
  });

  it('requestOtp reenvía type=PASSENGER aunque el caller inyecte type=DRIVER', async () => {
    const { service, bodies } = serviceWithCapture();
    // El caller intenta colar type=DRIVER (TS no lo permite en el DTO; simulamos un body crudo).
    await service.requestOtp({ phone: '+51987654321', type: ActorType.DRIVER } as never);
    expect(bodies[0]).toMatchObject({ phone: '+51987654321', type: ActorType.PASSENGER });
  });

  it('verifyOtp reenvía type=PASSENGER aunque el caller inyecte type=DRIVER', async () => {
    const { service, bodies } = serviceWithCapture();
    await service.verifyOtp({
      phone: '+51987654321',
      code: '123456',
      type: ActorType.DRIVER,
    } as never);
    expect(bodies[0]).toMatchObject({ type: ActorType.PASSENGER });
  });
});
