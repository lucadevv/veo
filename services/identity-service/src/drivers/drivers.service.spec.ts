import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableEntityError,
} from '@veo/utils';
import { DriversService } from './drivers.service';
import { InvalidStatusTransition } from '../domain/state-machine';
import { open } from '../common/secret-box';
import type { Env } from '../config/env.schema';

const DRIVER_DNI_ENC_KEY = 'k'.repeat(32);
const config = new ConfigService<Env, true>({ BIOMETRIC_MIN_SCORE: 90, DRIVER_DNI_ENC_KEY });
const futureLicense = new Date(Date.now() + 1_000_000_000);
const okDriver = {
  id: 'd1',
  userId: 'u1',
  suspendedAt: null as Date | null,
  currentStatus: 'OFFLINE',
  backgroundCheckStatus: 'CLEARED',
  licenseExpiresAt: futureLicense,
  faceEmbedding: [0.1, 0.2, 0.3],
  // Binding DNI↔selfie YA ejecutado (política nueva: approve() exige que el match haya corrido).
  // dniFaceMatched=true (MATCHED) es el caso feliz; dniFaceMatchedAt!=null es lo que mira el gate.
  dniFaceMatched: true as boolean | null,
  dniFaceMatchedAt: new Date('2026-01-01T00:00:00Z') as Date | null,
};

/** Fuentes válidas del eje DriverStatus hacia AVAILABLE (espeja driverStatusSources del servicio). */
const AVAILABLE_SOURCES = new Set(['OFFLINE', 'AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'ON_BREAK']);

/**
 * Prisma doble: `txDriver` simula el estado FRESCO que ve la tx (otro proceso pudo moverlo/suspenderlo
 * entre la réplica y la tx). El CAS del servicio (`updateMany` con `suspendedAt: null` +
 * `currentStatus in sources`) se modela respetando ese where sobre `txDriver`: matchea (count 1) solo si
 * NO está suspendido y su estado es una fuente válida hacia AVAILABLE.
 *
 * AUDITORÍA: el camino EXITOSO la escribe como su propia escritura suelta ANTES del CAS
 * (`write.biometricCheck.create`). El camino FALLIDO la escribe DENTRO de su propia tx de evidencia, JUNTO al
 * outbox `biometric.failed` (`tx.biometricCheck.create` + `tx.outboxEvent.create`) — una tx separada de la del
 * CAS. Ambos sumideros empujan al MISMO array `bioChecks`, así la aserción "la auditoría persiste" (#13) es
 * agnóstica al camino: el intento queda registrado venga por la escritura suelta o por la tx de evidencia.
 */
function makePrisma(driver: unknown, txDriver: unknown = driver) {
  const bioChecks: unknown[] = [];
  const recordBioCheck = async (args: unknown) => {
    bioChecks.push(args);
    return {};
  };
  const tx = txDriver as {
    suspendedAt?: Date | null;
    currentStatus?: string;
    faceEmbedding?: number[] | null;
  };
  // Espeja el WHERE del CAS atómico: NO suspendido, estado fuente válido Y embedding no vacío
  // (`faceEmbedding: { isEmpty: false }`) — todo sobre el dato FRESCO de la tx.
  const txHasEmbedding = Array.isArray(tx?.faceEmbedding) && tx.faceEmbedding.length > 0;
  const casMatches =
    !tx?.suspendedAt && AVAILABLE_SOURCES.has(tx?.currentStatus ?? '') && txHasEmbedding;
  return {
    bioChecks,
    read: { driver: { findUnique: async () => driver } },
    write: {
      driver: { update: async () => ({}) },
      biometricCheck: { create: recordBioCheck },
      outboxEvent: { create: async () => ({}) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          driver: {
            findUnique: async () => txDriver,
            updateMany: async () => ({ count: casMatches ? 1 : 0 }),
          },
          biometricCheck: { create: recordBioCheck },
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
      action: 'TURN_LEFT' as const,
      instructions: 'Gira la cabeza',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  },
  async enrollWithLiveness() {
    return {
      livenessPassed: true,
      embedding: [0.4, 0.5, 0.6],
      reason: null,
      takenAt: new Date().toISOString(),
    };
  },
  async embed() {
    return [0.4, 0.5, 0.6];
  },
  async verify() {
    return { score: 96, livenessPassed: true, matchPassed: true };
  },
  async matchDniFace() {
    return { matched: true, score: 96, reason: null };
  },
};
const bioFail = {
  ...bio,
  async verify() {
    return { score: 40, livenessPassed: false, matchPassed: false };
  },
};
/** Motor que NO detecta rostro en la selfie (embed devuelve []) → el enroll debe lanzar 422 (no_face). */
const bioNoFace = {
  ...bio,
  async embed() {
    return [] as number[];
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

describe('DriversService.createEnrollChallenge · reto de liveness del enrolamiento (BR-I02)', () => {
  it('devuelve el shape del reto (challengeId, action tipado, instructions, expiresAt)', async () => {
    const svc = new DriversService(
      makePrisma(okDriver) as never,
      makeRedis() as never,
      bio,
      config,
    );
    const out = await svc.createEnrollChallenge('u1');
    expect(out.challengeId).toBe('c1');
    expect(out.action).toBe('TURN_LEFT');
    expect(out.instructions).toBeTruthy();
    expect(out.expiresAt).toBeTruthy();
  });

  it('404 si el conductor no existe', async () => {
    const svc = new DriversService(
      makePrisma(null) as never,
      makeRedis() as never,
      bio,
      config,
    );
    await expect(svc.createEnrollChallenge('u1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('DriversService.enrollFace · enrolamiento KYC selfie-only (Lote 1, sin liveness)', () => {
  /** Prisma que captura el `data` del driver.update para aseverar que se persiste el embedding del motor. */
  function makeEnrollPrisma(driver: unknown) {
    const updates: {
      faceEmbedding?: number[];
      faceEnrolledAt?: Date;
      dniFaceMatched?: boolean | null;
      dniFaceMatchScore?: number | null;
      dniFaceMatchedAt?: Date | null;
    }[] = [];
    return {
      updates,
      read: { driver: { findUnique: async () => driver } },
      write: {
        driver: {
          update: async (args: { data: (typeof updates)[number] }) => {
            updates.push(args.data);
            return {};
          },
        },
      },
    };
  }

  it('rostro detectado → guarda el embedding derivado de la selfie + faceEnrolledAt', async () => {
    const prisma = makeEnrollPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const out = await svc.enrollFace('u1', { photo: 'selfie-base64' });
    expect(out.enrolled).toBe(true);
    expect(prisma.updates).toHaveLength(1);
    const [persisted] = prisma.updates;
    // Persiste EXACTAMENTE el embedding que devolvió embed (no uno inventado).
    expect(persisted?.faceEmbedding).toEqual([0.4, 0.5, 0.6]);
    expect(persisted?.faceEnrolledAt).toBeInstanceOf(Date);
  });

  it('sin rostro (embed → []) → 422 (UnprocessableEntityError) y NO escribe el embedding', async () => {
    const prisma = makeEnrollPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bioNoFace, config);
    await expect(
      svc.enrollFace('u1', { photo: 'selfie-base64' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(prisma.updates).toHaveLength(0);
  });

  it('404 si el conductor no existe', async () => {
    const svc = new DriversService(
      makeEnrollPrisma(null) as never,
      makeRedis() as never,
      bio,
      config,
    );
    await expect(
      svc.enrollFace('u1', { photo: 'selfie-base64' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('FIX 1 · INVALIDA EL BINDING: re-enrolar MUTA faceEmbedding y RESETEA los 3 campos del binding en la MISMA escritura', async () => {
    // Invariante de frescura: el binding (dniFaceMatched/Score/At) es evidencia contra el embedding cotejado.
    // Mutar el embedding lo invalida. El enroll debe limpiar los 3 campos JUNTO al embedding nuevo, así un
    // approve() posterior NO pasa con un binding stale (mismo patrón que resubmit()).
    const prisma = makeEnrollPrisma({
      ...okDriver,
      dniFaceMatched: true,
      dniFaceMatchScore: 96,
      dniFaceMatchedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.enrollFace('u1', { photo: 'selfie-base64' });
    expect(prisma.updates).toHaveLength(1);
    const [persisted] = prisma.updates;
    // Embedding nuevo persistido…
    expect(persisted?.faceEmbedding).toEqual([0.4, 0.5, 0.6]);
    expect(persisted?.faceEnrolledAt).toBeInstanceOf(Date);
    // …Y el binding reseteado a "no corrido" en la MISMA escritura (los 3 campos juntos).
    expect(persisted?.dniFaceMatched).toBeNull();
    expect(persisted?.dniFaceMatchScore).toBeNull();
    expect(persisted?.dniFaceMatchedAt).toBeNull();
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
    const prisma = makePrisma(okDriver);
    const svc = new DriversService(
      prisma as never,
      makeRedis({
        sessions: session('bad', { score: 40, livenessPassed: false, matchPassed: false }),
      }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'bad' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    // El intento fallido SÍ queda auditado (el assert de transición no aplica al camino fallido).
    expect(prisma.bioChecks).toHaveLength(1);
  });

  it('si una suspensión FRESCA cayó entre la réplica y la tx, el CAS rechaza pero la auditoría PERSISTE (#13)', async () => {
    // Réplica desactualizada dice OFFLINE/no-suspendido; la tx ve la fila FRESCA ya suspendida → el CAS
    // (where suspendedAt:null) no matchea (count 0) → ForbiddenError. La evidencia del intento biométrico
    // YA quedó persistida en su propia tx ANTES del CAS: un rechazo de transición NO borra la auditoría.
    const prisma = makePrisma(okDriver, { ...okDriver, suspendedAt: new Date() });
    const svc = new DriversService(
      prisma as never,
      makeRedis({ sessions: session('ok') }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).rejects.toBeInstanceOf(ForbiddenError);
    expect(prisma.bioChecks).toHaveLength(1);
  });

  it('estado fuente inválido en la tx (ej. ya SUSPENDED) → InvalidStatusTransition, auditoría PERSISTE', async () => {
    // La fila fresca NO está suspendida (suspendedAt null) pero su currentStatus no es fuente válida hacia
    // AVAILABLE → el CAS no matchea, el re-read no halla suspensión y assertTransition lanza el 409 tipado.
    const prisma = makePrisma(okDriver, {
      ...okDriver,
      currentStatus: 'SUSPENDED',
      suspendedAt: null,
    });
    const svc = new DriversService(
      prisma as never,
      makeRedis({ sessions: session('ok') }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).rejects.toBeInstanceOf(
      InvalidStatusTransition,
    );
    expect(prisma.bioChecks).toHaveLength(1);
  });

  it('double-shift por carrera: estado fuente válido pero el CAS no matchea (otro ganó) → ConflictError (#2)', async () => {
    // currentStatus OFFLINE ES fuente válida hacia AVAILABLE, así que assertTransition NO lanza; pero
    // forzamos count 0 (otro startShift concurrente ya movió la fila). El servicio lo discrimina como carrera.
    const prisma = makePrisma(okDriver, okDriver);
    // Forzamos el CAS a perder aunque el estado fuente sea válido (simula la carrera ganada por otro).
    prisma.write.$transaction = async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        driver: {
          findUnique: async () => okDriver,
          updateMany: async () => ({ count: 0 }),
        },
        outboxEvent: { create: async () => ({}) },
      });
    const svc = new DriversService(
      prisma as never,
      makeRedis({ sessions: session('ok') }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.bioChecks).toHaveLength(1);
  });

  it('rechaza si el sessionRef no existe o expiró', async () => {
    const svc = new DriversService(
      makePrisma(okDriver) as never,
      makeRedis() as never,
      bio,
      config,
    );
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

  it('GATE BIOMÉTRICO (TOCTOU): CLEARED pero faceEmbedding vacío en la réplica → ConflictError, NO transiciona', async () => {
    // La invariante "CLEARED ⟹ tiene embedding" se rompe cuando el sweeper de borrado vacía faceEmbedding
    // sin tocar backgroundCheckStatus. El gate barato de startShift (hasFaceEmbedding) corta ANTES del CAS:
    // ni siquiera consume sessionRef ni audita — falla rápido y closed.
    const prisma = makePrisma({ ...okDriver, faceEmbedding: [] });
    const svc = new DriversService(
      prisma as never,
      makeRedis({ sessions: session('ok') }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.bioChecks).toHaveLength(0);
  });

  it('GATE BIOMÉTRICO (TOCTOU/carrera): la réplica tiene embedding pero el sweeper lo vació entre réplica y tx → CAS no matchea → ConflictError, auditoría PERSISTE', async () => {
    // Réplica desactualizada: faceEmbedding presente (pasa el gate barato). La fila FRESCA de la tx ya tiene
    // faceEmbedding vacío (borrado concurrente): el CAS (isEmpty:false) NO matchea (count 0) → ConflictError
    // honesto "Biometría no enrolada". La evidencia del intento exitoso YA se persistió antes del CAS (#13).
    const prisma = makePrisma(okDriver, { ...okDriver, faceEmbedding: [] });
    const svc = new DriversService(
      prisma as never,
      makeRedis({ sessions: session('ok') }) as never,
      bio,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.bioChecks).toHaveLength(1);
  });
});

describe('DriversService.resubmit · reenvío a revisión (BR-I01 · M3)', () => {
  it('transiciona REJECTED→PENDING, limpia el motivo y EMITE driver.resubmitted por outbox (misma tx)', async () => {
    const outbox: { eventType: string }[] = [];
    const driverUpdates: Record<string, unknown>[] = [];
    const prisma = {
      write: {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            driver: {
              findUnique: async () => ({
                id: 'd1',
                userId: 'u1',
                backgroundCheckStatus: 'REJECTED',
              }),
              update: async (args: { data: Record<string, unknown> }) => {
                driverUpdates.push(args.data);
                return { id: 'd1', backgroundCheckStatus: 'PENDING' };
              },
            },
            user: {
              findUnique: async () => ({ id: 'u1', kycStatus: 'REJECTED' }),
              update: async () => ({}),
            },
            outboxEvent: {
              create: async (args: { data: { eventType: string } }) => {
                outbox.push({ eventType: args.data.eventType });
                return {};
              },
            },
          }),
      },
    };
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);

    const res = await svc.resubmit('u1');

    expect(res.backgroundCheckStatus).toBe('PENDING');
    // Limpia el motivo del rechazo previo.
    expect(driverUpdates[0]).toMatchObject({ backgroundCheckStatus: 'PENDING', rejectionReason: null });
    // EMITE el evento que cierra el double-source (admin-bff proyecta status=PENDING).
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('driver.resubmitted');
  });

  it('RESETEA el binding DNI↔selfie a "no corrido" (por-ciclo) en la MISMA tx que lleva a PENDING', async () => {
    // FIX 1: el binding es evidencia de ESTE ciclo, no histórico. Al reenviar (material corregido), el
    // cotejo viejo queda OBSOLETO → se limpia (matched/score/at = null) para OBLIGAR a re-correr el match.
    const driverUpdates: Record<string, unknown>[] = [];
    const prisma = {
      write: {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            driver: {
              findUnique: async () => ({
                id: 'd1',
                userId: 'u1',
                backgroundCheckStatus: 'REJECTED',
                // Binding del ciclo ANTERIOR (contra el DNI viejo): debe quedar en null tras el resubmit.
                dniFaceMatched: true,
                dniFaceMatchScore: 96,
                dniFaceMatchedAt: new Date('2026-01-01T00:00:00Z'),
              }),
              update: async (args: { data: Record<string, unknown> }) => {
                driverUpdates.push(args.data);
                return { id: 'd1', backgroundCheckStatus: 'PENDING' };
              },
            },
            user: {
              findUnique: async () => ({ id: 'u1', kycStatus: 'REJECTED' }),
              update: async () => ({}),
            },
            outboxEvent: { create: async () => ({}) },
          }),
      },
    };
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);

    await svc.resubmit('u1');

    // Los 3 campos del binding viajan en la MISMA escritura que el cambio a PENDING (coherencia atómica).
    expect(driverUpdates[0]).toMatchObject({
      backgroundCheckStatus: 'PENDING',
      dniFaceMatched: null,
      dniFaceMatchScore: null,
      dniFaceMatchedAt: null,
    });
  });
});

describe('DriversService.resubmit → approve · el binding reseteado VUELVE A MORDER el gate de approve()', () => {
  it('tras resubmit, un approve() SIN re-correr el match RECHAZA con 409 (binding reseteado a null)', async () => {
    // FIX 1 (end-to-end): resubmit() dejó dniFaceMatchedAt=null. approve() lee ese driver fresco y el gate de
    // EJECUCIÓN (dniFaceMatchedAt==null) corta → 409, SIN escribir. Re-aprobar OBLIGA a re-correr matchDniFace().
    const driverWrites: Record<string, unknown>[] = [];
    const prisma = {
      write: {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            driver: {
              findUnique: async () => ({
                ...okDriver,
                backgroundCheckStatus: 'PENDING',
                // Estado POST-resubmit: el binding fue reseteado, el match NO se re-ejecutó.
                dniFaceMatched: null,
                dniFaceMatchScore: null,
                dniFaceMatchedAt: null,
              }),
              update: async (args: { data: Record<string, unknown> }) => {
                driverWrites.push(args.data);
                return { id: 'd1', ...args.data };
              },
              updateMany: async (args: { data: Record<string, unknown> }) => {
                driverWrites.push(args.data);
                return { count: 1 };
              },
            },
            user: {
              findUnique: async () => ({ id: 'u1', kycStatus: 'PENDING' }),
              update: async () => ({}),
            },
            outboxEvent: { create: async () => ({}) },
          }),
      },
    };
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);

    await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(driverWrites).toHaveLength(0); // fail-closed: el gate corta ANTES de toda escritura
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
    expect(calls[0]?.data).toEqual({ suspendedAt: at, suspensionSource: 'DOCUMENT_EXPIRED' });
  });

  it('es idempotente: si ya estaba suspendido no aplica (count 0) y no reescribe el timestamp', async () => {
    const { prisma } = makeSuspendPrisma(true);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const applied = await svc.suspendByFleet('d1', new Date('2026-06-04T12:00:00.000Z'));
    expect(applied).toBe(false);
  });
});

describe('DriversService.suspend · suspensión MANUAL por operador (SAFETY)', () => {
  /**
   * Prisma doble: suspend lee el driver y hace CAS con updateMany DENTRO de la tx (espeja reject + suspendByFleet).
   * `alreadySuspended` simula la fila ya-suspendida (count 0 → no-op, sin evento). Captura writes y outbox.
   */
  function makeSuspendPrisma(driver: unknown, alreadySuspended = false) {
    const updateManyCalls: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    const outbox: Record<string, unknown>[] = [];
    const tx = {
      driver: {
        findUnique: async () => driver,
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          updateManyCalls.push(args);
          return { count: alreadySuspended ? 0 : 1 };
        },
      },
      outboxEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          outbox.push(data);
          return {};
        },
      },
    };
    return {
      updateManyCalls,
      outbox,
      prisma: {
        read: { driver: { findUnique: async () => driver } },
        write: { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) },
      },
    };
  }

  it('suspende un conductor no suspendido: CAS escribe suspendedAt y emite driver.suspended por outbox', async () => {
    const { prisma, updateManyCalls, outbox } = makeSuspendPrisma({
      ...okDriver,
      suspendedAt: null,
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.suspend('d1', 'Conducta peligrosa reportada');
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0]?.where).toEqual({ id: 'd1', suspendedAt: null });
    expect(updateManyCalls[0]?.data.suspendedAt).toBeInstanceOf(Date);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('driver.suspended');
    const envelope = outbox[0]?.envelope as {
      payload: { driverId: string; reason: string; suspendedAt: string };
    };
    expect(envelope.payload).toMatchObject({
      driverId: 'd1',
      reason: 'Conducta peligrosa reportada',
    });
    expect(typeof envelope.payload.suspendedAt).toBe('string');
  });

  it('es idempotente: si ya estaba suspendido (count 0) NO emite evento ni reescribe el timestamp', async () => {
    const { prisma, updateManyCalls, outbox } = makeSuspendPrisma(
      { ...okDriver, suspendedAt: new Date('2026-06-01T00:00:00.000Z') },
      true,
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.suspend('d1', 'motivo')).resolves.toBeUndefined();
    expect(updateManyCalls).toHaveLength(1); // intentó el CAS
    expect(outbox).toHaveLength(0); // pero no hubo evento (no-op honesto)
  });

  it('conductor inexistente → NotFoundError sin tocar el CAS ni el outbox', async () => {
    const { prisma, updateManyCalls, outbox } = makeSuspendPrisma(null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.suspend('ghost', 'motivo')).rejects.toBeInstanceOf(NotFoundError);
    expect(updateManyCalls).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });
});

describe('DriversService.reactivate · reactivación MANUAL por operador (SAFETY, fail-closed)', () => {
  /**
   * Prisma doble: reactivate lee el driver y hace CAS clear con updateMany DENTRO de la tx (espeja suspend).
   * `casCount` simula el resultado del CAS; `txReread` simula la fila que ve el re-read tras un CAS fallido
   * (carrera / source cambiado). Captura el where/data del CAS y el outbox.
   */
  function makeReactivatePrisma(
    driver: unknown,
    opts: { casCount?: number; txReread?: unknown } = {},
  ) {
    const updateManyCalls: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    const outbox: Record<string, unknown>[] = [];
    let findCalls = 0;
    const tx = {
      driver: {
        findUnique: async () => {
          findCalls += 1;
          // 1ra lectura: la fila inicial; 2da (solo si el CAS falló): el re-read del estado fresco.
          return findCalls === 1 ? driver : (opts.txReread ?? driver);
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          updateManyCalls.push(args);
          return { count: opts.casCount ?? 1 };
        },
      },
      outboxEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          outbox.push(data);
          return {};
        },
      },
    };
    return {
      updateManyCalls,
      outbox,
      prisma: {
        read: { driver: { findUnique: async () => driver } },
        write: { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) },
      },
    };
  }

  const suspendedDisciplinary = {
    ...okDriver,
    suspendedAt: new Date('2026-06-01T00:00:00.000Z'),
    suspensionSource: 'DISCIPLINARY',
  };

  it('happy path DISCIPLINARY: limpia suspendedAt+source (CAS) y emite driver.reactivated por outbox', async () => {
    const { prisma, updateManyCalls, outbox } = makeReactivatePrisma(suspendedDisciplinary);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.reactivate('d1');
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0]?.where).toMatchObject({
      id: 'd1',
      suspendedAt: { not: null },
      suspensionSource: 'DISCIPLINARY',
    });
    expect(updateManyCalls[0]?.data).toEqual({ suspendedAt: null, suspensionSource: null });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('driver.reactivated');
    const envelope = outbox[0]?.envelope as { payload: { driverId: string; reactivatedAt: string } };
    expect(envelope.payload.driverId).toBe('d1');
    expect(typeof envelope.payload.reactivatedAt).toBe('string');
  });

  it('conductor NO suspendido → ConflictError sin tocar el CAS ni el outbox', async () => {
    const { prisma, updateManyCalls, outbox } = makeReactivatePrisma({
      ...okDriver,
      suspendedAt: null,
      suspensionSource: null,
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reactivate('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(updateManyCalls).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it('suspensión DOCUMENT_EXPIRED → ForbiddenError (fail-closed: no se levanta a mano)', async () => {
    const { prisma, updateManyCalls, outbox } = makeReactivatePrisma({
      ...okDriver,
      suspendedAt: new Date('2026-06-01T00:00:00.000Z'),
      suspensionSource: 'DOCUMENT_EXPIRED',
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reactivate('d1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(updateManyCalls).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it('source null (fila legacy) → ForbiddenError (fail-closed: ante la duda, no reactiva)', async () => {
    const { prisma, updateManyCalls } = makeReactivatePrisma({
      ...okDriver,
      suspendedAt: new Date('2026-06-01T00:00:00.000Z'),
      suspensionSource: null,
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reactivate('d1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(updateManyCalls).toHaveLength(0);
  });

  it('licencia vencida → ForbiddenError aunque la suspensión sea DISCIPLINARY', async () => {
    const { prisma, outbox } = makeReactivatePrisma({
      ...suspendedDisciplinary,
      licenseExpiresAt: new Date(Date.now() - 1_000_000),
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reactivate('d1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(outbox).toHaveLength(0);
  });

  it('conductor inexistente → NotFoundError', async () => {
    const { prisma } = makeReactivatePrisma(null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reactivate('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('CAS pierde por carrera (ya reactivado): re-read ve suspendedAt null → ConflictError honesto', async () => {
    const { prisma, outbox } = makeReactivatePrisma(suspendedDisciplinary, {
      casCount: 0,
      txReread: { suspendedAt: null, suspensionSource: null },
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reactivate('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(outbox).toHaveLength(0);
  });
});

describe('DriversService.updatePersonalInfo · datos personales (BR-I04)', () => {
  /**
   * Prisma doble del UPSERT (fix P0 order-independence). `existing` simula la fila previa: null = paso 1
   * del wizard SIN fila Driver (caso que antes daba 404). El doble captura el branch usado (create/update)
   * y refleja en el resultado el merge de la fila previa con los datos enviados (mapeo dni→document_id),
   * para verificar tanto la vista devuelta como la materialización del cascarón.
   */
  function makePersonalPrisma(existing: Record<string, unknown> | null) {
    const upsertCalls: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }[] = [];
    return {
      upsertCalls,
      prisma: {
        read: { driver: { findUnique: async () => existing } },
        write: {
          driver: {
            upsert: async ({
              create,
              update,
            }: {
              create: Record<string, unknown>;
              update: Record<string, unknown>;
            }) => {
              upsertCalls.push({ create, update });
              // Sin fila previa → la rama create define el estado final; con fila previa → merge update.
              // El DNI se persiste CIFRADO (`document_id_enc`); la vista NO se arma de esta fila sino del input
              // plano (enmascarado), así que el shape de la fila solo se usa para inspeccionar el upsert.
              const data = existing ? { ...existing, ...update } : create;
              return {
                legalName: (data.legalName as string | null) ?? null,
                documentIdEnc: (data.documentIdEnc as string | null) ?? null,
                birthDate: (data.birthDate as Date | null) ?? null,
              };
            },
          },
        },
      },
    };
  }

  it('NO devuelve el DNI crudo al conductor: lo enmascara (últimos 4) en la vista (PII Ley 29733)', async () => {
    const { prisma } = makePersonalPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const out = await svc.updatePersonalInfo('u1', {
      legalName: 'Juan Pérez',
      dni: '12345678',
      birthDate: '1990-05-20',
    });
    // El conductor YA tipeó el DNI; se le confirma ENMASCARADO, nunca el crudo ni el ciphertext.
    expect(out).toEqual({ legalName: 'Juan Pérez', dni: '****5678', birthDate: '1990-05-20' });
    expect(out.dni).not.toBe('12345678');
  });

  it('persiste el DNI CIFRADO (no en claro) y round-trip: open(documentIdEnc) === dni original', async () => {
    const { prisma, upsertCalls } = makePersonalPrisma(null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const dni = '12345678';
    await svc.updatePersonalInfo('u1', { legalName: 'Juan', dni, birthDate: '1990-05-20' });
    const persisted = upsertCalls[0]?.create.documentIdEnc as string;
    // (a) lo persistido NO es el DNI en claro
    expect(persisted).toBeTypeOf('string');
    expect(persisted).not.toBe(dni);
    expect(persisted).not.toContain(dni);
    // (b) round-trip reversible: descifrado === DNI original (compliance lo muestra al operador)
    expect(open(persisted, DRIVER_DNI_ENC_KEY)).toBe(dni);
    // El upsert NO escribe la columna en claro `documentId` (eliminada del schema).
    expect(upsertCalls[0]?.create).not.toHaveProperty('documentId');
  });

  it('personal-first: SIN fila Driver previa crea el cascarón y fija los datos (ya NO 404, fix P0)', async () => {
    const { prisma, upsertCalls } = makePersonalPrisma(null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const out = await svc.updatePersonalInfo('u1', {
      legalName: 'Ana',
      dni: '87654321',
      birthDate: '1992-01-10',
    });
    expect(out).toEqual({ legalName: 'Ana', dni: '****4321', birthDate: '1992-01-10' });
    // El cascarón se materializa con los defaults tipados del agregado (sin strings mágicos).
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]?.create).toMatchObject({
      userId: 'u1',
      currentStatus: 'OFFLINE',
      backgroundCheckStatus: 'PENDING',
      legalName: 'Ana',
    });
    // El DNI va CIFRADO (round-trip), nunca en claro en la fila.
    expect(open(upsertCalls[0]?.create.documentIdEnc as string, DRIVER_DNI_ENC_KEY)).toBe('87654321');
  });

  it('re-submit idempotente: llamar dos veces no rompe ni duplica (upsert por userId)', async () => {
    const { prisma, upsertCalls } = makePersonalPrisma({ ...okDriver, legalName: 'Ana' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const input = { legalName: 'Ana María', dni: '87654321', birthDate: '1992-01-10' };
    await svc.updatePersonalInfo('u1', input);
    await svc.updatePersonalInfo('u1', input);
    // Dos upsert al MISMO unique userId: idempotente, sin error de conflicto.
    expect(upsertCalls).toHaveLength(2);
  });
});

describe('DriversService.onboard · alta de licencia idempotente y orden-independiente (fix P0)', () => {
  /**
   * Prisma doble del UPSERT. `existing` simula si ya hay fila Driver (p. ej. porque corrió antes
   * `updatePersonalInfo`). Captura el branch create/update y refleja el merge para verificar order-independence.
   * `user` modela la validación previa (User type DRIVER, no borrado).
   */
  function makeOnboardPrisma(
    existing: Record<string, unknown> | null,
    user: Record<string, unknown> | null = { id: 'u1', type: 'DRIVER', deletedAt: null },
  ) {
    const upsertCalls: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }[] = [];
    return {
      upsertCalls,
      prisma: {
        read: {
          user: { findUnique: async () => user },
          driver: { findUnique: async () => existing },
        },
        write: {
          driver: {
            upsert: async ({
              create,
              update,
            }: {
              create: Record<string, unknown>;
              update: Record<string, unknown>;
            }) => {
              upsertCalls.push({ create, update });
              const data = existing ? { ...existing, ...update } : create;
              return {
                id: (data.id as string) ?? 'd-new',
                backgroundCheckStatus: (data.backgroundCheckStatus as string) ?? 'PENDING',
              };
            },
          },
        },
      },
    };
  }

  const license = { licenseNumber: 'L-123', licenseExpiresAt: futureLicense.toISOString() };

  it('onboard-first: SIN fila previa crea el cascarón con la licencia y queda PENDING', async () => {
    const { prisma, upsertCalls } = makeOnboardPrisma(null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const out = await svc.onboard('u1', license);
    expect(out).toEqual({ driverId: 'd-new', backgroundCheckStatus: 'PENDING' });
    expect(upsertCalls[0]?.create).toMatchObject({
      userId: 'u1',
      licenseNumber: 'L-123',
      currentStatus: 'OFFLINE',
      backgroundCheckStatus: 'PENDING',
    });
  });

  it('onboard-after-personal: con cascarón ya creado fija la licencia y NO lanza ConflictError', async () => {
    const { prisma, upsertCalls } = makeOnboardPrisma({
      id: 'd1',
      legalName: 'Ana',
      backgroundCheckStatus: 'PENDING',
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const out = await svc.onboard('u1', license);
    expect(out).toEqual({ driverId: 'd1', backgroundCheckStatus: 'PENDING' });
    // Solo actualiza el slice de licencia: no pisa otros campos del agregado.
    expect(upsertCalls[0]?.update).toEqual({ licenseNumber: 'L-123', licenseExpiresAt: futureLicense });
  });

  it('re-submit idempotente: onboard dos veces no rompe ni duplica (upsert por userId)', async () => {
    const { prisma, upsertCalls } = makeOnboardPrisma({ id: 'd1', backgroundCheckStatus: 'PENDING' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.onboard('u1', license);
    await svc.onboard('u1', license);
    expect(upsertCalls).toHaveLength(2);
  });

  it('rechaza si el usuario no existe o está borrado (404)', async () => {
    const { prisma } = makeOnboardPrisma(null, null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.onboard('u1', license)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rechaza si el usuario no es conductor (403)', async () => {
    const { prisma } = makeOnboardPrisma(null, { id: 'u1', type: 'PASSENGER', deletedAt: null });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.onboard('u1', license)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('DriversService.setStatus · transición de turno validada por la máquina', () => {
  /** Prisma doble que refleja el currentStatus escrito (para verificar qué se persistió). */
  function makeStatusPrisma(driver: unknown) {
    const writes: Record<string, unknown>[] = [];
    return {
      writes,
      prisma: {
        read: { driver: { findUnique: async () => driver } },
        write: {
          driver: {
            update: async ({ data }: { data: Record<string, unknown> }) => {
              writes.push(data);
              return { currentStatus: data.currentStatus };
            },
          },
        },
      },
    };
  }

  it('permite el fin de turno AVAILABLE → OFFLINE', async () => {
    const { prisma } = makeStatusPrisma({ ...okDriver, currentStatus: 'AVAILABLE' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.setStatus('u1', 'OFFLINE')).resolves.toEqual({ status: 'OFFLINE' });
  });

  it('un SUSPENDED NO puede auto-ponerse AVAILABLE ni saltándose el tipo (409, no escribe)', async () => {
    // AVAILABLE ya NI compila como SelfServiceDriverStatus (gate compile-time del retoque);
    // el cast simula un bypass del tipo para fijar que la máquina sigue rechazando en runtime.
    const { prisma, writes } = makeStatusPrisma({ ...okDriver, currentStatus: 'SUSPENDED' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.setStatus('u1', 'AVAILABLE' as never)).rejects.toBeInstanceOf(
      InvalidStatusTransition,
    );
    expect(writes).toHaveLength(0);
  });

  it('no hay pausa sin turno: OFFLINE → ON_BREAK es inválida', async () => {
    const { prisma } = makeStatusPrisma({ ...okDriver, currentStatus: 'OFFLINE' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.setStatus('u1', 'ON_BREAK')).rejects.toBeInstanceOf(InvalidStatusTransition);
  });

  it('currentStatus legacy fuera del enum → 409 fail-closed, nunca TypeError', async () => {
    const { prisma } = makeStatusPrisma({ ...okDriver, currentStatus: 'LEGACY_GARBAGE' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.setStatus('u1', 'OFFLINE')).rejects.toBeInstanceOf(InvalidStatusTransition);
  });
});

describe('DriversService.approve/reject · decisión de antecedentes validada por las máquinas', () => {
  /**
   * Prisma doble: approve y reject leen DENTRO de la tx. `overrides` permite que la tx vea un
   * estado distinto al de la réplica (simula lag de réplica / decisión concurrente).
   */
  function makeApprovalPrisma(
    driver: unknown,
    user: unknown,
    overrides: {
      txDriver?: unknown;
      txUser?: unknown;
      // Override SOLO de `dniFaceMatchedAt` tal como lo VE el CAS (no el pre-read): modela una nulificación
      // concurrente que aterriza ESTRICTAMENTE entre el pre-read (que ve el binding fresco) y el CAS.
      casDniFaceMatchedAt?: Date | null;
    } = {},
  ) {
    const txDriver = 'txDriver' in overrides ? overrides.txDriver : driver;
    const txUser = 'txUser' in overrides ? overrides.txUser : user;
    const driverWrites: Record<string, unknown>[] = [];
    const userWrites: Record<string, unknown>[] = [];
    const outbox: { eventType: string }[] = [];
    // approve() transiciona por CAS atómico: `updateMany({ where: { backgroundCheckStatus in {PENDING,REJECTED} } })`.
    // El doble espeja ese WHERE sobre el estado FRESCO de la tx: matchea (count 1) solo si el estado fuente AÚN
    // no es CLEARED (un PENDING/REJECTED legítimo); si ya está CLEARED (otra tx ganó la carrera) → count 0,
    // no-op idempotente sin re-emitir. reject() sigue por update normal (no CAS): se mantiene intacto.
    const CLAIM_SOURCES = new Set(['PENDING', 'REJECTED']);
    const tx = {
      driver: {
        findUnique: async () => txDriver,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          driverWrites.push(data);
          return { id: 'd1', ...data };
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: {
            backgroundCheckStatus?: { in: string[] };
            dniFaceMatchedAt?: { not: null };
          };
          data: Record<string, unknown>;
        }) => {
          const fresh = txDriver as {
            backgroundCheckStatus?: string;
            dniFaceMatchedAt?: Date | null;
          };
          const current = fresh?.backgroundCheckStatus;
          // FIX 2: el CAS de approve() matchea solo si (1) el estado fresco está en el `in` del WHERE
          // (PENDING/REJECTED) Y (2) el binding sigue fresco (`dniFaceMatchedAt != null`). Espeja la cláusula
          // `dniFaceMatchedAt: { not: null }` plegada en el WHERE: si una tx concurrente nulificó el binding
          // entre el pre-read y el CAS, la fila fresca tiene dniFaceMatchedAt=null → NO matchea (count 0).
          // `casDniFaceMatchedAt` permite que el CAS vea un binding DISTINTO al del pre-read (la nulificación
          // aterriza estrictamente entre ambos); sin override, el CAS ve el mismo binding que la tx.
          const casMatchedAt =
            'casDniFaceMatchedAt' in overrides ? overrides.casDniFaceMatchedAt : fresh?.dniFaceMatchedAt;
          const bindingFresh = where.dniFaceMatchedAt === undefined || casMatchedAt != null;
          const matches =
            current != null &&
            CLAIM_SOURCES.has(current) &&
            (where.backgroundCheckStatus?.in.includes(current) ?? false) &&
            bindingFresh;
          if (matches) driverWrites.push(data);
          return { count: matches ? 1 : 0 };
        },
      },
      user: {
        findUnique: async () => txUser,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          userWrites.push(data);
          return { id: 'u1', ...data };
        },
      },
      outboxEvent: {
        create: async ({ data }: { data: { eventType: string } }) => {
          outbox.push({ eventType: data.eventType });
          return {};
        },
      },
    };
    return {
      driverWrites,
      userWrites,
      outbox,
      prisma: {
        read: {
          driver: { findUnique: async () => driver },
          user: { findUnique: async () => user },
        },
        write: {
          $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
        },
      },
    };
  }

  it('aprueba un PENDING: antecedentes → CLEARED y KYC → VERIFIED', async () => {
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.approve('d1');
    expect(driverWrites).toEqual([{ backgroundCheckStatus: 'CLEARED' }]);
    expect(userWrites).toEqual([{ kycStatus: 'VERIFIED' }]);
  });

  it('GATE BIOMÉTRICO: rechaza la aprobación con 409 si el conductor NO enroló biometría (faceEmbedding vacío)', async () => {
    // Diferenciador no negociable VEO: sin embedding de referencia NO hay aprobación. El gate corta
    // ANTES de los asserts de máquina y de toda escritura (fail-closed, cero efectos).
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING', faceEmbedding: [] },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
  });

  it('GATE BIOMÉTRICO: rechaza la aprobación con 409 si faceEmbedding es null (nunca enroló)', async () => {
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING', faceEmbedding: null },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
  });

  it('GATE FACE-MATCH (a): rechaza con 409 si el binding DNI↔selfie NUNCA se ejecutó (dniFaceMatchedAt=null)', async () => {
    // Curl-proof: sin haber corrido matchDniFace() (dniFaceMatchedAt=null) NO se aprueba a ciegas.
    // El gate corta ANTES de los asserts de máquina y de toda escritura (fail-closed, cero efectos).
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING', dniFaceMatched: null, dniFaceMatchedAt: null },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
  });

  it('GATE FACE-MATCH (b): PERMITE aprobar con veredicto NO_MATCH (dniFaceMatched=false) si el match SÍ se ejecutó', async () => {
    // El gate es de EJECUCIÓN, NO de veredicto: un NO_MATCH (dniFaceMatched=false) con dniFaceMatchedAt
    // seteado lo decide el OPERADOR que lo vio → la aprobación procede normal (CLEARED + VERIFIED).
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      {
        ...okDriver,
        backgroundCheckStatus: 'PENDING',
        dniFaceMatched: false,
        dniFaceMatchedAt: new Date('2026-01-01T00:00:00Z'),
      },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.approve('d1');
    expect(driverWrites).toEqual([{ backgroundCheckStatus: 'CLEARED' }]);
    expect(userWrites).toEqual([{ kycStatus: 'VERIFIED' }]);
  });

  it('GATE FACE-MATCH (c): aprueba normal con veredicto MATCHED (dniFaceMatched=true, dniFaceMatchedAt set)', async () => {
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      {
        ...okDriver,
        backgroundCheckStatus: 'PENDING',
        dniFaceMatched: true,
        dniFaceMatchedAt: new Date('2026-01-01T00:00:00Z'),
      },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.approve('d1');
    expect(driverWrites).toEqual([{ backgroundCheckStatus: 'CLEARED' }]);
    expect(userWrites).toEqual([{ kycStatus: 'VERIFIED' }]);
  });

  it('CAS gana-una-sola-vez: el approve() ganador transiciona PENDING→CLEARED y EMITE driver.verified UNA vez', async () => {
    // FIX 2: la transición es por CAS atómico. El ganador matchea (count 1) → un solo driver.verified.
    const { prisma, driverWrites, userWrites, outbox } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.approve('d1');
    expect(driverWrites).toEqual([{ backgroundCheckStatus: 'CLEARED' }]);
    expect(userWrites).toEqual([{ kycStatus: 'VERIFIED' }]);
    expect(outbox).toEqual([{ eventType: 'driver.verified' }]); // EXACTAMENTE un evento
  });

  it('CAS perdedor de la carrera (otra tx ya dejó CLEARED): no-op idempotente SIN re-emitir driver.verified', async () => {
    // FIX 2: dos approve() concurrentes leen ambos PENDING (READ COMMITTED) y pasan el assert, pero el CAS lo
    // gana UNO solo. El perdedor ve la fila ya CLEARED en la tx (fuera del WHERE del CAS) → count 0 → NO toca
    // user, NO emite outbox (evita el double-emit de driver.verified). El gate de face-match SÍ pasa (binding
    // ejecutado), para aislar que lo que corta el segundo evento es el CAS, no un gate previo.
    const { prisma, driverWrites, userWrites, outbox } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
      // La tx ve el estado FRESCO: otra tx ya transicionó la fila a CLEARED entre la lectura y el CAS.
      { txDriver: { ...okDriver, backgroundCheckStatus: 'CLEARED' } },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const res = await svc.approve('d1');
    expect(res.backgroundCheckStatus).toBe('CLEARED'); // honesto: ya está aprobado
    expect(driverWrites).toHaveLength(0); // el CAS no matcheó (count 0)
    expect(userWrites).toHaveLength(0); // no re-escribe el KYC del usuario
    expect(outbox).toHaveLength(0); // y NO re-emite driver.verified (cero double-emit)
  });

  it('FIX 1+2 · POST-ENROLL SIN RE-MATCH: re-enrolar otra cara nulifica el binding → approve() RECHAZA con 409 (cero writes)', async () => {
    // El escenario que el gate adversarial confirmó: un PENDING con match ya corrido re-enrola OTRA cara
    // (enrollFace MUTA faceEmbedding y, con FIX 1, RESETEA dniFaceMatchedAt=null). Si después se intenta
    // aprobar SIN re-correr matchDniFace(), el gate de ejecución (dniFaceMatchedAt==null) ahora MUERDE → 409.
    // Antes de FIX 1, el binding quedaba apuntando al embedding viejo y el approve PASABA con material stale.
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      {
        ...okDriver,
        backgroundCheckStatus: 'PENDING',
        // Estado tras el re-enroll: embedding nuevo presente, binding nulificado por FIX 1.
        dniFaceMatched: null,
        dniFaceMatchScore: null,
        dniFaceMatchedAt: null,
      },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
  });

  it('FIX 2 · CAS ATÓMICO (TOCTOU): el binding pasa el pre-read pero una tx concurrente lo nulifica → CAS no matchea (count 0), NO aprueba ni emite', async () => {
    // El pre-read ve un binding presente (dniFaceMatchedAt set) y pasa el 409 amigable; PERO entre ese read y
    // el CAS, un resubmit()/enrollFace() concurrente nulificó el binding. La fila FRESCA de la tx tiene
    // dniFaceMatchedAt=null → el `dniFaceMatchedAt: { not: null }` plegado en el WHERE del CAS NO matchea
    // (count 0) → fail-closed: no se aprueba, no se toca user, no se emite driver.verified. El gate de frescura
    // es ATÓMICO con la transición (sin TOCTOU).
    const { prisma, driverWrites, userWrites, outbox } = makeApprovalPrisma(
      // El pre-read (dentro de la tx) ve el binding fresco (dniFaceMatchedAt set) → pasa el 409 amigable.
      {
        ...okDriver,
        backgroundCheckStatus: 'PENDING',
        dniFaceMatchedAt: new Date('2026-01-01T00:00:00Z'),
      },
      { id: 'u1', kycStatus: 'PENDING' },
      // PERO el CAS (que corre DESPUÉS del pre-read) ve el binding YA nulificado por una carrera que aterrizó
      // estrictamente entre el pre-read y el CAS → el `dniFaceMatchedAt: { not: null }` del WHERE no matchea.
      { casDniFaceMatchedAt: null },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const res = await svc.approve('d1');
    // Fail-closed: el binding stale NO se aprueba. count 0 → no-op honesto (la fila quedó PENDING).
    expect(res.backgroundCheckStatus).toBe('PENDING');
    expect(driverWrites).toHaveLength(0); // el CAS no matcheó (binding nulificado en la tx)
    expect(userWrites).toHaveLength(0); // no toca el KYC del usuario
    expect(outbox).toHaveLength(0); // NO emite driver.verified
  });

  it('re-aprueba un REJECTED (apelación): REJECTED → CLEARED es válida', async () => {
    const { prisma, driverWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'REJECTED' },
      { id: 'u1', kycStatus: 'REJECTED' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.approve('d1');
    expect(driverWrites).toEqual([{ backgroundCheckStatus: 'CLEARED' }]);
  });

  it('backgroundCheckStatus legacy fuera del enum → 409 fail-closed sin escribir', async () => {
    const { prisma, driverWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'LEGACY_GARBAGE' },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.approve('d1')).rejects.toBeInstanceOf(InvalidStatusTransition);
    expect(driverWrites).toHaveLength(0);
  });

  it('rechaza un CLEARED (revocación por hallazgo posterior): CLEARED → REJECTED es válida', async () => {
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'CLEARED' },
      { id: 'u1', kycStatus: 'VERIFIED' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await svc.reject('d1', 'Antecedente penal hallado');
    expect(driverWrites).toHaveLength(1);
    expect(driverWrites[0]).toMatchObject({
      backgroundCheckStatus: 'REJECTED',
      rejectionReason: 'Antecedente penal hallado',
    });
    expect(driverWrites[0]?.rejectedAt).toBeInstanceOf(Date);
    expect(userWrites).toEqual([{ kycStatus: 'REJECTED' }]);
  });

  it('reject TOCTOU: la réplica decía PENDING pero la tx ve un estado inválido → 409 con CERO writes', async () => {
    // El assert corre sobre lo que ve la TX, no la réplica: un from fuera del enum (fila legacy)
    // es fail-closed SIEMPRE. (→ REJECTED es válida desde todo estado del enum, y re-aplicar el
    // mismo estado es no-op idempotente por diseño; el 409 serializado aparece en este caso.)
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
      { txDriver: { ...okDriver, backgroundCheckStatus: 'LEGACY_GARBAGE' } },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reject('d1', 'motivo')).rejects.toBeInstanceOf(InvalidStatusTransition);
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
  });

  it('reject concurrente que ya dejó REJECTED: re-aplicación idempotente (no-op válido por diseño)', async () => {
    const { prisma, driverWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
      {
        txDriver: { ...okDriver, backgroundCheckStatus: 'REJECTED' },
        txUser: { id: 'u1', kycStatus: 'REJECTED' },
      },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reject('d1', 'motivo')).resolves.toBeUndefined();
    expect(driverWrites).toHaveLength(1);
    expect(driverWrites[0]).toMatchObject({
      backgroundCheckStatus: 'REJECTED',
      rejectionReason: 'motivo',
    });
  });

  it('reject: 404 si el conductor no existe (la lectura vive dentro de la tx)', async () => {
    const { prisma, driverWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
      { txDriver: null },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reject('d1', 'motivo')).rejects.toBeInstanceOf(NotFoundError);
    expect(driverWrites).toHaveLength(0);
  });

  it('reject: 404 si el usuario del conductor no existe (la lectura vive dentro de la tx)', async () => {
    const { prisma, driverWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
      { txUser: null },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(svc.reject('d1', 'motivo')).rejects.toBeInstanceOf(NotFoundError);
    expect(driverWrites).toHaveLength(0);
  });
});

describe('DriversService.matchDniFace · BINDING DNI↔selfie (sub-lote 3C)', () => {
  /** Prisma que captura el `data` del driver.update para aseverar que el resultado del match se GUARDA. */
  function makeMatchPrisma(driver: unknown) {
    const updates: {
      dniFaceMatched?: boolean;
      dniFaceMatchScore?: number;
      dniFaceMatchedAt?: Date;
    }[] = [];
    return {
      updates,
      read: { driver: { findUnique: async () => driver } },
      write: {
        driver: {
          update: async (args: { data: (typeof updates)[number] }) => {
            updates.push(args.data);
            return {};
          },
        },
      },
    };
  }

  it('corre el match contra el embedding GUARDADO y PERSISTE el resultado (matched/score/at)', async () => {
    const prisma = makeMatchPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    const out = await svc.matchDniFace('d1', { image: 'base64-dni-front' });
    // Devuelve el veredicto del motor (sandbox bio → matched true, score 96).
    expect(out).toEqual({ matched: true, score: 96, reason: null });
    // GUARDA el resultado en una sola escritura: veredicto + score + momento.
    expect(prisma.updates).toHaveLength(1);
    const [persisted] = prisma.updates;
    expect(persisted?.dniFaceMatched).toBe(true);
    expect(persisted?.dniFaceMatchScore).toBe(96);
    expect(persisted?.dniFaceMatchedAt).toBeInstanceOf(Date);
  });

  it('sin biometría enrolada → 409 (ConflictError) y NO escribe nada', async () => {
    const prisma = makeMatchPrisma({ ...okDriver, faceEmbedding: [] });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(
      svc.matchDniFace('d1', { image: 'base64-dni-front' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.updates).toHaveLength(0);
  });

  it('404 si el conductor no existe', async () => {
    const prisma = makeMatchPrisma(null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, config);
    await expect(
      svc.matchDniFace('d1', { image: 'base64-dni-front' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.updates).toHaveLength(0);
  });

  it('NO coincide → persiste matched=false con el score y el motivo del motor', async () => {
    const prisma = makeMatchPrisma(okDriver);
    // Motor que reporta no-coincidencia (espeja el biometric-service real / el sandbox con threshold).
    const bioNoMatch = {
      ...bio,
      async matchDniFace() {
        return { matched: false, score: 33, reason: 'no coincide' };
      },
    };
    const svc = new DriversService(prisma as never, makeRedis() as never, bioNoMatch, config);
    const out = await svc.matchDniFace('d1', { image: 'base64-dni-front' });
    expect(out.matched).toBe(false);
    expect(prisma.updates[0]?.dniFaceMatched).toBe(false);
    expect(prisma.updates[0]?.dniFaceMatchScore).toBe(33);
  });
});
