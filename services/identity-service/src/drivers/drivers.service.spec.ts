import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '@veo/utils';
import { DriversService } from './drivers.service';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({ BIOMETRIC_MIN_SCORE: 90 });
const futureLicense = new Date(Date.now() + 1_000_000_000);
const okDriver = {
  id: 'd1',
  userId: 'u1',
  suspendedAt: null as Date | null,
  backgroundCheckStatus: 'CLEARED',
  licenseExpiresAt: futureLicense,
  faceEmbedding: [0.1, 0.2, 0.3],
};

function makePrisma(driver: unknown) {
  return {
    read: { driver: { findUnique: async () => driver } },
    write: {
      driver: { update: async () => ({}) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          biometricCheck: { create: async () => ({}) },
          driver: { update: async () => ({}) },
          outboxEvent: { create: async () => ({}) },
        }),
    },
  };
}

/** Redis doble: simula el contador de lockout + el almacén del sessionRef de un solo uso. */
function makeRedis(opts: { fails?: number; sessions?: Record<string, string> } = {}) {
  const store = new Map<string, string>(Object.entries(opts.sessions ?? {}));
  let fails = opts.fails ?? 0;
  return {
    store,
    async get(key: string): Promise<string | null> {
      if (key.startsWith('veo:bio:fails:')) return fails > 0 ? String(fails) : null;
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<'OK'> {
      store.set(key, value);
      return 'OK';
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
    async incr(): Promise<number> {
      fails += 1;
      return fails;
    },
    async expire(): Promise<number> {
      return 1;
    },
  };
}

const bio = {
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
const bioFail = {
  ...bio,
  async verify() {
    return { score: 40, livenessPassed: false, matchPassed: false };
  },
};

/** Sesión válida pre-minteada para un sessionRef dado. */
function session(ref: string, partial: Record<string, unknown> = {}) {
  return {
    [`veo:bio:session:${ref}`]: JSON.stringify({
      userId: 'u1',
      kind: 'SHIFT_START',
      score: 96,
      livenessPassed: true,
      matchPassed: true,
      ...partial,
    }),
  };
}

describe('DriversService.verifyBiometric · minteo de sessionRef (BR-I02)', () => {
  it('mintea un sessionRef de un solo uso al verificar', async () => {
    const redis = makeRedis();
    const svc = new DriversService(makePrisma(okDriver) as never, redis as never, bio, config);
    const out = await svc.verifyBiometric('u1', { challengeId: 'c1', frames: ['f1'] });
    expect(out.sessionRef).toBeTruthy();
    expect(out.score).toBe(96);
    expect(redis.store.get(`veo:bio:session:${out.sessionRef}`)).toBeTruthy();
  });

  it('rechaza si el conductor no está enrolado biométricamente', async () => {
    const svc = new DriversService(
      makePrisma({ ...okDriver, faceEmbedding: [] }) as never,
      makeRedis() as never,
      bio,
      config,
    );
    await expect(
      svc.verifyBiometric('u1', { challengeId: 'c1', frames: ['f1'] }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('mintea sessionRef incluso cuando la verificación no pasa (para el lockout en startShift)', async () => {
    const redis = makeRedis();
    const svc = new DriversService(makePrisma(okDriver) as never, redis as never, bioFail, config);
    const out = await svc.verifyBiometric('u1', { challengeId: 'c1', frames: ['f1'] });
    expect(out.livenessPassed).toBe(false);
    expect(redis.store.get(`veo:bio:session:${out.sessionRef}`)).toBeTruthy();
  });
});

describe('DriversService.enrollFace · enrolamiento (BR-I02)', () => {
  it('guarda el embedding de referencia', async () => {
    const svc = new DriversService(makePrisma(okDriver) as never, makeRedis() as never, bio, config);
    const out = await svc.enrollFace('u1', { photo: 'Zm90bw==' });
    expect(out.enrolled).toBe(true);
  });
});

describe('DriversService.startShift · gate biométrico (BR-I02)', () => {
  it('habilita el turno consumiendo un sessionRef válido', async () => {
    const svc = new DriversService(
      makePrisma(okDriver) as never,
      makeRedis({ sessions: session('ok') }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).resolves.toEqual({
      status: 'AVAILABLE',
      score: 96,
    });
  });

  it('rechaza y cuenta el intento cuando el sessionRef refleja una verificación fallida', async () => {
    const svc = new DriversService(
      makePrisma(okDriver) as never,
      makeRedis({
        sessions: session('bad', { score: 40, livenessPassed: false, matchPassed: false }),
      }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'bad' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('rechaza si el sessionRef no existe o expiró', async () => {
    const svc = new DriversService(makePrisma(okDriver) as never, makeRedis() as never, bio, config);
    await expect(svc.startShift('u1', { sessionRef: 'missing' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('rechaza si el sessionRef pertenece a otro conductor', async () => {
    const svc = new DriversService(
      makePrisma(okDriver) as never,
      makeRedis({ sessions: session('other', { userId: 'u2' }) }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'other' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('no permite turno si el KYC no está aprobado', async () => {
    const svc = new DriversService(
      makePrisma({ ...okDriver, backgroundCheckStatus: 'PENDING' }) as never,
      makeRedis({ sessions: session('ok') }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('bloquea tras 3 intentos fallidos (lockout 1h)', async () => {
    const svc = new DriversService(
      makePrisma(okDriver) as never,
      makeRedis({ fails: 3, sessions: session('ok') }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rechaza conductor suspendido', async () => {
    const svc = new DriversService(
      makePrisma({ ...okDriver, suspendedAt: new Date() }) as never,
      makeRedis({ sessions: session('ok') }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('DriversService.suspendByFleet · suspensión por fleet (cierre del lazo)', () => {
  /** Prisma doble que captura el where de updateMany y simula la fila ya-suspendida/no-suspendida. */
  function makeSuspendPrisma(alreadySuspended: boolean) {
    const calls: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    return {
      calls,
      prisma: {
        read: { driver: { findUnique: async () => null } },
        write: {
          driver: {
            updateMany: async (args: {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }) => {
              calls.push(args);
              // El where exige suspendedAt: null → si ya estaba suspendido no matchea ninguna fila.
              return { count: alreadySuspended ? 0 : 1 };
            },
          },
        },
      },
    };
  }

  it('escribe suspendedAt y reporta que aplicó cuando el conductor no estaba suspendido', async () => {
    const { prisma, calls } = makeSuspendPrisma(false);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const at = new Date('2026-06-04T10:00:00.000Z');
    const applied = await svc.suspendByFleet('d1', at);
    expect(applied).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.where).toEqual({ id: 'd1', suspendedAt: null });
    expect(calls[0]?.data).toEqual({ suspendedAt: at });
  });

  it('es idempotente: si ya estaba suspendido no aplica (count 0) y no reescribe el timestamp', async () => {
    const { prisma } = makeSuspendPrisma(true);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const applied = await svc.suspendByFleet('d1', new Date('2026-06-04T12:00:00.000Z'));
    expect(applied).toBe(false);
  });
});

describe('DriversService.updatePersonalInfo · datos personales (BR-I04)', () => {
  /** Prisma doble: refleja en la actualización los datos enviados (mapeo dni→document_id). */
  function makePersonalPrisma(driver: unknown) {
    return {
      read: { driver: { findUnique: async () => driver } },
      write: {
        driver: {
          update: async ({ data }: { data: Record<string, unknown> }) => ({
            legalName: (data.legalName as string | null) ?? null,
            documentId: (data.documentId as string | null) ?? null,
            birthDate: (data.birthDate as Date | null) ?? null,
          }),
        },
      },
    };
  }

  it('persiste y devuelve los datos con birthDate en yyyy-mm-dd', async () => {
    const svc = new DriversService(
      makePersonalPrisma(okDriver) as never,
      makeRedis() as never,
      bio,
      config,
    );
    const out = await svc.updatePersonalInfo('u1', {
      legalName: 'Juan Pérez',
      dni: '12345678',
      birthDate: '1990-05-20',
    });
    expect(out).toEqual({ legalName: 'Juan Pérez', dni: '12345678', birthDate: '1990-05-20' });
  });

  it('lanza NotFoundError si el conductor no existe', async () => {
    const svc = new DriversService(
      makePersonalPrisma(null) as never,
      makeRedis() as never,
      bio,
      config,
    );
    await expect(
      svc.updatePersonalInfo('u1', { legalName: 'X', dni: '12345678', birthDate: '1990-05-20' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
