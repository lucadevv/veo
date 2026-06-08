import { describe, it, expect } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import { KycService } from './kyc.service';
import type { VerifyKycDto } from './dto/kyc.dto';

const user = { userId: 'u1', roles: [] } as unknown as AuthenticatedUser;

/** Doble del InternalRestClient: registra la última llamada y devuelve una respuesta fija. */
function makeRest(response: unknown) {
  const calls: { path: string; body: unknown }[] = [];
  return {
    calls,
    client: {
      post: async (path: string, req: { body: unknown }) => {
        calls.push({ path, body: req.body });
        return response;
      },
    },
  };
}

describe('KycService.challenge (public-bff)', () => {
  it('reenvía a identity con body vacío y devuelve el reto', async () => {
    const rest = makeRest({
      challengeId: 'c1',
      action: 'TURN_LEFT',
      instructions: 'Gira',
      expiresAt: '2026-05-30T00:00:00.000Z',
    });
    const svc = new KycService(rest.client as never);
    const out = await svc.challenge(user);

    expect(rest.calls[0]?.path).toBe('/users/kyc/challenge');
    expect(rest.calls[0]?.body).toEqual({});
    expect(out.challengeId).toBe('c1');
  });
});

describe('KycService.verify (public-bff)', () => {
  it('aplana los frames a base64 plano y reexpone el veredicto', async () => {
    const rest = makeRest({ status: 'VERIFIED', verificationId: 'v1' });
    const svc = new KycService(rest.client as never);
    const dto: VerifyKycDto = {
      challengeId: 'c1',
      frames: [
        { base64Jpeg: 'AAA', width: 640, height: 480, capturedAt: 1 },
        { base64Jpeg: 'BBB', width: 640, height: 480, capturedAt: 2 },
      ],
    };
    const out = await svc.verify(user, dto);

    expect(rest.calls[0]?.path).toBe('/users/kyc/verify');
    expect(rest.calls[0]?.body).toEqual({ challengeId: 'c1', frames: ['AAA', 'BBB'] });
    expect(out.status).toBe('VERIFIED');
    expect(out.verificationId).toBe('v1');
  });

  it('propaga el rechazo con su reason', async () => {
    const rest = makeRest({ status: 'REJECTED', verificationId: 'v2', reason: 'liveness_failed' });
    const svc = new KycService(rest.client as never);
    const out = await svc.verify(user, {
      challengeId: 'c1',
      frames: [{ base64Jpeg: 'AAA', width: 640, height: 480, capturedAt: 1 }],
    });
    expect(out.status).toBe('REJECTED');
    expect(out.reason).toBe('liveness_failed');
  });
});
