import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ForbiddenError } from '@veo/utils';
import { KycService } from './kyc.service';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({ BIOMETRIC_MIN_SCORE: 90 });

const passenger = { id: 'u1', type: 'PASSENGER', deletedAt: null as Date | null };

/** Prisma doble: usuario de lectura + transacción de escritura que captura el update emitido. */
function makePrisma(user: unknown, captured?: { update?: unknown; outbox?: unknown }) {
  return {
    read: { user: { findUnique: async () => user } },
    write: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          user: {
            update: async (args: unknown) => {
              if (captured) captured.update = args;
              return {};
            },
          },
          outboxEvent: {
            create: async (args: unknown) => {
              if (captured) captured.outbox = args;
              return {};
            },
          },
        }),
    },
  };
}

const bioPass = {
  async createChallenge() {
    return {
      challengeId: 'c1',
      action: 'TURN_LEFT',
      instructions: 'Gira la cabeza',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  },
  async embed() {
    return [0.4, 0.5, 0.6];
  },
  async verify() {
    return { score: 96, livenessPassed: true, matchPassed: true };
  },
};

const bioLivenessFail = {
  ...bioPass,
  async verify() {
    return { score: 40, livenessPassed: false, matchPassed: false };
  },
};

describe('KycService.verify · KYC del pasajero (liveness OK → VERIFIED)', () => {
  it('verifica al pasajero, marca VERIFIED y emite user.kyc_verified al outbox', async () => {
    const captured: { update?: unknown; outbox?: unknown } = {};
    const svc = new KycService(makePrisma(passenger, captured) as never, bioPass, config);
    const out = await svc.verify('u1', { challengeId: 'c1', frames: ['f1', 'f2'] });

    expect(out.status).toBe('VERIFIED');
    expect(out.verificationId).toBeTruthy();
    expect(out.reason).toBeUndefined();
    const update = captured.update as { data: { kycStatus: string; faceEmbedding: number[] } };
    expect(update.data.kycStatus).toBe('VERIFIED');
    expect(update.data.faceEmbedding).toEqual([0.4, 0.5, 0.6]);
    const outbox = captured.outbox as { data: { eventType: string } };
    expect(outbox.data.eventType).toBe('user.kyc_verified');
  });

  it('rechaza sin cambiar kycStatus cuando el liveness falla', async () => {
    const captured: { update?: unknown; outbox?: unknown } = {};
    const svc = new KycService(makePrisma(passenger, captured) as never, bioLivenessFail, config);
    const out = await svc.verify('u1', { challengeId: 'c1', frames: ['f1'] });

    expect(out.status).toBe('REJECTED');
    expect(out.reason).toBe('liveness_failed');
    expect(out.verificationId).toBeTruthy();
    // No se tocó el usuario ni se emitió evento.
    expect(captured.update).toBeUndefined();
    expect(captured.outbox).toBeUndefined();
  });

  it('rechaza si el usuario no es pasajero (es conductor)', async () => {
    const svc = new KycService(
      makePrisma({ ...passenger, type: 'DRIVER' }) as never,
      bioPass,
      config,
    );
    await expect(
      svc.verify('u1', { challengeId: 'c1', frames: ['f1'] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('KycService.createChallenge', () => {
  it('emite un reto de liveness para el pasajero', async () => {
    const svc = new KycService(makePrisma(passenger) as never, bioPass, config);
    const challenge = await svc.createChallenge('u1');
    expect(challenge.challengeId).toBe('c1');
  });

  it('rechaza el reto si el usuario no es pasajero', async () => {
    const svc = new KycService(
      makePrisma({ ...passenger, type: 'DRIVER' }) as never,
      bioPass,
      config,
    );
    await expect(svc.createChallenge('u1')).rejects.toBeInstanceOf(ForbiddenError);
  });
});
