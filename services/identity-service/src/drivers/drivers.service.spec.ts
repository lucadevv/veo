import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  ConflictError,
  DniAlreadyRegisteredError,
  ForbiddenError,
  hashPii,
  InvalidStateError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableEntityError,
} from '@veo/utils';
import { DriversService } from './drivers.service';
import { InvalidStatusTransition } from '../domain/state-machine';
import { open } from '../common/secret-box';
import type { Env } from '../config/env.schema';

const DRIVER_DNI_ENC_KEY = 'k'.repeat(32);
const DNI_HASH_SALT = 'test-dni-salt';
const config = new ConfigService<Env, true>({
  BIOMETRIC_MIN_SCORE: 90,
  DRIVER_DNI_ENC_KEY,
  DNI_HASH_SALT,
  EXCESSIVE_CANCELLATION_COOLDOWN_HOURS: 24,
});
/**
 * Stub del RedisRefreshTokenStore (Lote 1b + backstop durable): la suspensión llama `revokeAllForUser` (fast-path)
 * y las 4 vías event-driven llaman `resealRevokedBefore` (backstop durable, incondicional). Default no-op; los
 * tests que ASERTAN el revoke/reseal usan su propio spy (vi.fn).
 */
const sessions = { revokeAllForUser: async () => 0, resealRevokedBefore: async () => true } as never;
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
  // Binding licencia↔selfie YA ejecutado (Lote C · approve() exige AMBOS bindings corridos).
  licenseFaceMatched: true as boolean | null,
  licenseFaceMatchedAt: new Date('2026-01-01T00:00:00Z') as Date | null,
  // Liveness PASIVO YA ejecutado (PAD corrió → PASSED): approve() exige `livenessChecked === true`. El caso feliz.
  livenessChecked: true as boolean | null,
  livenessScore: 0.95 as number | null,
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

/**
 * Redis doble: simula el contador de lockout + el almacén del sessionRef de un solo uso.
 *
 * `eval` modela FIELMENTE el script Lua `FIXED_WINDOW_INCR_EXPIRE` que `consumeFixedWindow` (@veo/utils)
 * ejecuta: INCR de la key + PEXPIRE en el PRIMER hit (o si la key quedó sin TTL, ttl===-1), devolviendo
 * `[count, ttl]`. Así el INCREMENTO ATÓMICO del lockout en el fallo de `verifyBiometric` (A1/M6) se cuenta de
 * verdad (no un valor fijo): tras el eval, `get(bioLockKey)` refleja el contador real y `consumed.count` es el
 * que ve el servicio. El TTL se rastrea en `ttls` para respetar la semántica de ventana FIJA (no se re-arma en
 * cada hit sano). La key `veo:bio:fails:*` comparte el mismo contador `fails` que `get`/`incr`/`del`, así el
 * eval y las lecturas del lockout son coherentes entre sí.
 */
function makeRedis(opts: { fails?: number; sessions?: Record<string, string> } = {}) {
  const store = new Map<string, string>(Object.entries(opts.sessions ?? {}));
  const ttls = new Map<string, number>();
  let fails = opts.fails ?? 0;
  const isFailsKey = (key: string) => key.startsWith('veo:bio:fails:');
  return {
    store,
    async get(key: string): Promise<string | null> {
      if (isFailsKey(key)) return fails > 0 ? String(fails) : null;
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<'OK'> {
      store.set(key, value);
      return 'OK';
    },
    async del(key: string): Promise<number> {
      if (isFailsKey(key)) {
        const had = fails > 0;
        fails = 0;
        ttls.delete(key);
        return had ? 1 : 0;
      }
      return store.delete(key) ? 1 : 0;
    },
    async incr(): Promise<number> {
      fails += 1;
      return fails;
    },
    async expire(): Promise<number> {
      return 1;
    },
    // Espeja FIXED_WINDOW_INCR_EXPIRE (ver packages/utils/src/rate-limit.ts): INCR + PEXPIRE-en-el-primer-hit
    // (o saneo si ttl===-1), retorno `[count, ttl]`. numKeys=1, args=[key, windowMs].
    async eval(_script: string, _numKeys: number, ...args: Array<string | number>): Promise<[number, number]> {
      const key = String(args[0]);
      const windowMs = Number(args[1]);
      let count: number;
      if (isFailsKey(key)) {
        fails += 1;
        count = fails;
      } else {
        count = Number(store.get(key) ?? 0) + 1;
        store.set(key, String(count));
      }
      let ttl = ttls.get(key) ?? -1;
      if (count === 1 || ttl === -1) {
        ttls.set(key, windowMs);
        ttl = windowMs;
      }
      return [count, ttl];
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
  async enrollPassive() {
    // Registro con liveness pasivo OK (persona viva): embedding + live=true.
    return {
      embedding: [0.4, 0.5, 0.6] as number[] | null,
      live: true,
      livenessChecked: true,
      score: 0.95,
      reason: null as string | null,
    };
  },
};
const bioFail = {
  ...bio,
  async verify() {
    return { score: 40, livenessPassed: false, matchPassed: false };
  },
};
/** Motor que NO detecta rostro en la selfie (enrollPassive sin embedding) → el enroll lanza 422 (no_face). */
const bioNoFace = {
  ...bio,
  async embed() {
    return [] as number[];
  },
  async enrollPassive() {
    return {
      embedding: null as number[] | null,
      live: true,
      livenessChecked: false,
      score: 0,
      reason: null as string | null,
    };
  },
};
/** Motor que detecta SPOOF (foto/pantalla): livenessChecked && !live → el enroll lanza 422 (spoof). */
const bioSpoof = {
  ...bio,
  async enrollPassive() {
    return {
      embedding: null as number[] | null,
      live: false,
      livenessChecked: true,
      score: 0.1,
      reason: 'spoof' as string | null,
    };
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
    const svc = new DriversService(makePrisma(okDriver) as never, redis as never, bio, sessions, config);
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
      sessions,
      config,
    );
    await expect(
      svc.verifyBiometric('u1', { challengeId: 'c1', frames: ['f1'] }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('cuando la verificación NO pasa: NO mintea sessionRef, AUDITA el intento, cuenta el lockout y lanza UnauthorizedError (A1)', async () => {
    // CONTRATO NUEVO (A1): el lockout anti-bruteforce se movió AL motor de match (verify), el choke point real.
    // Un fallo YA NO mintea un sessionRef "para que startShift cuente" — verify TIRA UnauthorizedError, deja la
    // traza forense (biometric.failed en su propia tx) e incrementa el contador atómico (consumeFixedWindow).
    const prisma = makePrisma(okDriver);
    const redis = makeRedis();
    const svc = new DriversService(prisma as never, redis as never, bioFail, sessions, config);
    await expect(
      svc.verifyBiometric('u1', { challengeId: 'c1', frames: ['f1'] }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    // NO se minteó NINGUNA sesión (verify ya no mintea en fallo → startShift no tiene qué consumir).
    const sessionKeys = [...redis.store.keys()].filter((k) => k.startsWith('veo:bio:session:'));
    expect(sessionKeys).toHaveLength(0);
    // El intento fallido dejó traza (evidencia Ley 29733) y contó el lockout (INCR atómico → 1 fallo).
    expect(prisma.bioChecks).toHaveLength(1);
    expect(await redis.get('veo:bio:fails:d1')).toBe('1');
  });

  it('bloquea tras 3 intentos fallidos (lockout 1h): con 3 fallos previos verify → ForbiddenError SIN correr el match (A1)', async () => {
    // El invariante "3 fallos → bloqueo 1h" (BR-I02) vive AHORA en verify (antes en startShift). Con el contador
    // en el techo, verify corta de entrada: ni siquiera invoca el motor de match (usa `bio`, que pasaría).
    const svc = new DriversService(
      makePrisma(okDriver) as never,
      makeRedis({ fails: 3 }) as never,
      bio,
      sessions,
      config,
    );
    await expect(
      svc.verifyBiometric('u1', { challengeId: 'c1', frames: ['f1'] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('DriversService.createEnrollChallenge · reto de liveness del enrolamiento (BR-I02)', () => {
  it('devuelve el shape del reto (challengeId, action tipado, instructions, expiresAt)', async () => {
    const svc = new DriversService(
      makePrisma(okDriver) as never,
      makeRedis() as never,
      bio,
      sessions,
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
      sessions,
      config,
    );
    await expect(svc.createEnrollChallenge('u1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('DriversService.enrollFace · enrolamiento KYC con liveness PASIVO (PAD anti-spoofing)', () => {
  /**
   * Prisma que captura el `data` del driver.update (embedding) Y los eventos de outbox (auditoría F1). El
   * enrol exitoso persiste el embedding + emite `biometric.enrolled` ATÓMICAMENTE (una tx); el rechazo por
   * spoof emite `biometric.enroll_rejected` en escritura propia. El mock modela ambos caminos.
   */
  function makeEnrollPrisma(driver: unknown) {
    const updates: {
      faceEmbedding?: number[];
      faceEnrolledAt?: Date;
      faceSelfieKey?: string | null;
      livenessChecked?: boolean | null;
      livenessScore?: number | null;
      dniFaceMatched?: boolean | null;
      dniFaceMatchScore?: number | null;
      dniFaceMatchedAt?: Date | null;
    }[] = [];
    const outbox: { eventType: string }[] = [];
    const driverWrite = {
      update: async (args: { data: (typeof updates)[number] }) => {
        updates.push(args.data);
        return {};
      },
    };
    const outboxEvent = {
      create: async (args: { data: { eventType: string } }) => {
        outbox.push(args.data);
        return {};
      },
    };
    return {
      updates,
      outbox,
      read: { driver: { findUnique: async () => driver } },
      write: {
        driver: driverWrite,
        outboxEvent,
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ driver: driverWrite, outboxEvent }),
      },
    };
  }

  it('rostro detectado → guarda el embedding derivado de la selfie + faceEnrolledAt', async () => {
    const prisma = makeEnrollPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const out = await svc.enrollFace('u1', { photo: 'selfie-base64' });
    expect(out.enrolled).toBe(true);
    expect(prisma.updates).toHaveLength(1);
    const [persisted] = prisma.updates;
    // Persiste EXACTAMENTE el embedding que devolvió embed (no uno inventado).
    expect(persisted?.faceEmbedding).toEqual([0.4, 0.5, 0.6]);
    expect(persisted?.faceEnrolledAt).toBeInstanceOf(Date);
    // Persiste el veredicto del liveness PASIVO de ESTE enrol (lo VE el operador + lo exige approve()): el PAD
    // corrió (livenessChecked=true) con score 0.95 de la clase viva, tal como los devolvió enrollPassive.
    expect(persisted?.livenessChecked).toBe(true);
    expect(persisted?.livenessScore).toBe(0.95);
    // AUDITORÍA F1 (Ley 29733): el enrol exitoso emite `biometric.enrolled` ATÓMICO con la persistencia.
    expect(prisma.outbox.map((e) => e.eventType)).toEqual(['biometric.enrolled']);
    // F5: sin selfieKey en el input → faceSelfieKey null (la subida del BFF es best-effort, pudo no venir).
    expect(persisted?.faceSelfieKey).toBeNull();
  });

  it('F5 · selfieKey con prefijo del PROPIO conductor → se guarda faceSelfieKey', async () => {
    const prisma = makeEnrollPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.enrollFace('u1', { photo: 'selfie-base64', selfieKey: 'drivers/d1/kyc-selfie.jpg' });
    expect(prisma.updates[0]?.faceSelfieKey).toBe('drivers/d1/kyc-selfie.jpg');
  });

  it('F5 · selfieKey con prefijo AJENO → se IGNORA (null, defense-in-depth, no confía en key arbitraria)', async () => {
    const prisma = makeEnrollPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    // okDriver.id = 'd1'; una key de OTRO conductor NO debe persistirse (aunque el caller sea interno/firmado).
    await svc.enrollFace('u1', { photo: 'selfie-base64', selfieKey: 'drivers/OTRO-DRIVER/kyc-selfie.jpg' });
    expect(prisma.updates[0]?.faceSelfieKey).toBeNull();
  });

  it('sin rostro (enrollPassive sin embedding) → 422 (UnprocessableEntityError) y NO escribe ni audita', async () => {
    const prisma = makeEnrollPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bioNoFace, sessions, config);
    await expect(
      svc.enrollFace('u1', { photo: 'selfie-base64' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(prisma.updates).toHaveLength(0);
    // no_face es ruido operativo (no se detectó persona) → NO se audita (ningún evento de outbox).
    expect(prisma.outbox).toHaveLength(0);
  });

  it('SPOOF (PAD: livenessChecked && !live) → 422, NO enrola, pero SÍ deja traza forense', async () => {
    const prisma = makeEnrollPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bioSpoof, sessions, config);
    await expect(
      svc.enrollFace('u1', { photo: 'selfie-base64' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
    // Un ataque de presentación (foto impresa / pantalla) NO se enrola…
    expect(prisma.updates).toHaveLength(0);
    // …PERO deja TRAZA INMUTABLE del intento de suplantación (Ley 29733 · F1), aunque el request termine en 422.
    expect(prisma.outbox.map((e) => e.eventType)).toEqual(['biometric.enroll_rejected']);
  });

  it('404 si el conductor no existe', async () => {
    const svc = new DriversService(
      makeEnrollPrisma(null) as never,
      makeRedis() as never,
      bio,
      sessions,
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
      sessions,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).resolves.toEqual({
      status: 'AVAILABLE',
      score: 96,
    });
  });

  it('guard DEFENSIVO: una sesión biométrica corrupta (no-pasó) → UnauthorizedError SIN auditar NI contar (verify es el único dueño del lockout)', async () => {
    // CONTRATO NUEVO: verify SOLO mintea sesión cuando PASÓ, así una sesión "no-pasó" no debería existir. Si por
    // corrupción llegara una, startShift la corta con un guard defensivo ANTES de la escritura de auditoría y SIN
    // tocar el lockout (el conteo del fallo ya lo hizo —o lo hará— verify; startShift no re-cuenta ni re-audita).
    const prisma = makePrisma(okDriver);
    const redis = makeRedis({
      sessions: session('bad', { score: 40, livenessPassed: false, matchPassed: false }),
    });
    const svc = new DriversService(prisma as never, redis as never, bio, sessions, config);
    await expect(svc.startShift('u1', { sessionRef: 'bad' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    // El guard corta ANTES del biometricCheck.create → NO hay auditoría del "intento" en startShift…
    expect(prisma.bioChecks).toHaveLength(0);
    // …y NO incrementa el lockout (verify es el dueño exclusivo del contador).
    expect(await redis.get('veo:bio:fails:d1')).toBeNull();
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
      sessions,
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
      sessions,
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
      sessions,
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
      sessions,
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
      sessions,
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
      sessions,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('el lockout ya NO vive en startShift: con 3 fallos previos pero sessionRef VÁLIDO, HABILITA el turno (el gate se movió a verify)', async () => {
    // El bloqueo por 3 fallos se movió a verifyBiometric (A1/M6): startShift ya NO lee ni cuenta el lockout.
    // Un contador en 3 (fallos previos) con una sesión que PASÓ debe habilitar el turno — la prueba de que el
    // gate se movió al método correcto. (El bloqueo real de "3 fallos" lo cubre el test gemelo en verifyBiometric.)
    const svc = new DriversService(
      makePrisma(okDriver) as never,
      makeRedis({ fails: 3, sessions: session('ok') }) as never,
      bio,
      sessions,
      config,
    );
    await expect(svc.startShift('u1', { sessionRef: 'ok' })).resolves.toEqual({
      status: 'AVAILABLE',
      score: 96,
    });
  });

  it('rechaza conductor suspendido', async () => {
    const svc = new DriversService(
      makePrisma({ ...okDriver, suspendedAt: new Date() }) as never,
      makeRedis({ sessions: session('ok') }) as never,
      bio,
      sessions,
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
      sessions,
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
      sessions,
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);

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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);

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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);

    await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(driverWrites).toHaveLength(0); // fail-closed: el gate corta ANTES de toda escritura
  });
});

/**
 * FAKE de la tabla `DriverSuspensionHold` + el `Driver` derivado, en memoria, con la SEMÁNTICA REAL del modelo
 * de HOLDS (natural key `[driverId, cause, causeRef]`, upsert idempotente, deleteMany por where, count, findFirst
 * por createdAt asc) y la DERIVACIÓN de `suspendedAt` (createdAt del hold más viejo, o null con 0 holds). Así los
 * tests verifican el COMPORTAMIENTO del modelo (multi-causa, idempotencia, derivación) y no el shape de un CAS.
 *
 * Cada hold: `{ driverId, cause, causeRef, reason, createdAt }`. El driver arranca con `suspendedAt` derivado de
 * los holds iniciales. Una sola "tx" (no hace falta aislar: los métodos corren una tx que envuelve todo).
 */
interface Hold {
  driverId: string;
  cause: string;
  causeRef: string;
  reason: string;
  createdAt: Date;
}
function holdMatches(h: Hold, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'driverId') {
      if (h.driverId !== v) return false;
    } else if (k === 'cause') {
      // cause puede ser un valor escalar, `{ in: [...] }` o `{ not: ... }` (complemento de una causa).
      if (v && typeof v === 'object' && 'in' in (v as Record<string, unknown>)) {
        if (!(v as { in: string[] }).in.includes(h.cause)) return false;
      } else if (v && typeof v === 'object' && 'not' in (v as Record<string, unknown>)) {
        if (h.cause === (v as { not: string }).not) return false;
      } else if (h.cause !== v) return false;
    } else if (k === 'causeRef') {
      if (h.causeRef !== v) return false;
    }
  }
  return true;
}
/**
 * @param driverExists  si false, el findUnique del driver devuelve null (evento antes del onboarding).
 * @param initialHolds  holds preexistentes del conductor (para los escenarios multi-causa).
 * @param driverId      id de perfil del conductor del fake (default 'd1').
 * @param userId        userId del conductor (para resolver userId→driverId en las vías por-user).
 */
function makeHoldPrisma(opts: {
  driverExists?: boolean;
  initialHolds?: Hold[];
  driverId?: string;
  userId?: string;
  driver?: Record<string, unknown>;
} = {}) {
  const driverId = opts.driverId ?? 'd1';
  const userId = opts.userId ?? 'u1';
  const holds: Hold[] = [...(opts.initialHolds ?? [])];
  const outbox: Record<string, unknown>[] = [];
  const driverExists = opts.driverExists ?? true;

  const deriveSuspendedAt = (): Date | null => {
    const mine = holds.filter((h) => h.driverId === driverId);
    if (mine.length === 0) return null;
    return mine.reduce((min, h) => (h.createdAt < min ? h.createdAt : min), mine[0]!.createdAt);
  };
  // El driver derivado: suspendedAt SIEMPRE refleja los holds actuales (se relee fresco en cada findUnique).
  const driverRow = () =>
    driverExists
      ? { id: driverId, userId, licenseExpiresAt: futureLicense, ...opts.driver, suspendedAt: deriveSuspendedAt() }
      : null;

  const holdClient = {
    findUnique: async ({
      where,
    }: {
      where: { driverId_cause_causeRef: { driverId: string; cause: string; causeRef: string } };
    }) => {
      const k = where.driverId_cause_causeRef;
      return holds.find(
        (h) => h.driverId === k.driverId && h.cause === k.cause && h.causeRef === k.causeRef,
      ) ?? null;
    },
    findFirst: async ({ where }: { where: { driverId: string } }) => {
      const mine = holds
        .filter((h) => h.driverId === where.driverId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return mine[0] ?? null;
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      holds.filter((h) => holdMatches(h, where)).length,
    upsert: async ({
      where,
      create,
    }: {
      where: { driverId_cause_causeRef: { driverId: string; cause: string; causeRef: string } };
      create: Hold;
    }) => {
      const k = where.driverId_cause_causeRef;
      const found = holds.find(
        (h) => h.driverId === k.driverId && h.cause === k.cause && h.causeRef === k.causeRef,
      );
      // update vacío → no-op si existe (preserva createdAt); create si no (idempotencia por natural key).
      if (!found) holds.push({ ...create, createdAt: create.createdAt ?? new Date() });
      return {};
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = holds.length;
      for (let i = holds.length - 1; i >= 0; i--) {
        if (holdMatches(holds[i]!, where)) holds.splice(i, 1);
      }
      return { count: before - holds.length };
    },
  };

  const tx = {
    driver: {
      findUnique: async ({ where }: { where: { id?: string; userId?: string } }) => {
        // resuelve por id o por userId (las vías por-user resuelven userId→driverId).
        if (where.userId !== undefined && where.userId !== userId) return null;
        if (where.id !== undefined && where.id !== driverId) return null;
        return driverRow();
      },
      // recomputeSuspendedAt escribe el campo derivado. FIEL A LA DB REAL: si el Driver NO existe, Prisma
      // `update({ where: { id } })` LANZA P2025 (record-not-found) — NO devuelve {}. El fake viejo devolvía {}
      // incondicional y enmascaraba el POISON-PILL (reactivateByFleet sin guard recomputaba sobre un driver
      // inexistente sin reventar en test, pero en prod lanzaba P2025 → Kafka reintenta ∞). Con esto, un update
      // sobre un driver ausente revienta como en prod → el guard de existencia se vuelve TESTEABLE.
      update: async () => {
        if (!driverExists) {
          const err = new Error(
            'An operation failed because it depends on one or more records that were required but not found.',
          );
          err.name = 'PrismaClientKnownRequestError';
          (err as unknown as { code: string }).code = 'P2025';
          throw err;
        }
        return {};
      },
    },
    driverSuspensionHold: holdClient,
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        outbox.push(data);
        return {};
      },
    },
  };

  return {
    holds,
    outbox,
    deriveSuspendedAt,
    prisma: {
      read: { driver: { findUnique: async () => driverRow() } },
      write: {
        driver: { findUnique: tx.driver.findUnique },
        driverSuspensionHold: holdClient,
        $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      },
    },
  };
}

/** Hold helper para armar estados iniciales en los tests. */
function hold(cause: string, causeRef: string, createdAt: string, driverId = 'd1'): Hold {
  return { driverId, cause, causeRef, reason: `seed ${cause}`, createdAt: new Date(createdAt) };
}

describe('DriversService.suspendByFleet · suspensión por DOCUMENTO (hold DOCUMENT_EXPIRED, causeRef=docType)', () => {
  it('agrega un hold DOCUMENT_EXPIRED con causeRef=documentType y deriva suspendedAt', async () => {
    const { prisma, holds } = makeHoldPrisma();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const at = new Date('2026-06-04T10:00:00.000Z');
    const applied = await svc.suspendByFleet('d1', at, 'SOAT');
    expect(applied).toBe(true);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      driverId: 'd1',
      cause: 'DOCUMENT_EXPIRED',
      causeRef: 'SOAT',
      createdAt: at,
    });
  });

  it('es IDEMPOTENTE: re-suspender el MISMO documento (mismo causeRef) → no crea otro hold, reporta false', async () => {
    const { prisma, holds } = makeHoldPrisma({
      initialHolds: [hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const applied = await svc.suspendByFleet('d1', new Date('2026-06-04T12:00:00.000Z'), 'SOAT');
    expect(applied).toBe(false);
    expect(holds).toHaveLength(1); // sigue siendo 1: el upsert fue no-op (preserva el createdAt original).
    expect(holds[0]?.createdAt).toEqual(new Date('2026-06-01T00:00:00.000Z'));
  });

  it('DOS documentos distintos (SOAT + LICENSE_A1) → DOS holds (causeRef distinto)', async () => {
    const { prisma, holds } = makeHoldPrisma({
      initialHolds: [hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const applied = await svc.suspendByFleet('d1', new Date('2026-06-05T00:00:00.000Z'), 'LICENSE_A1');
    expect(applied).toBe(true);
    expect(holds).toHaveLength(2);
  });

  it('conductor inexistente (evento antes del onboarding) → no-op silencioso false, sin holds', async () => {
    const { prisma, holds } = makeHoldPrisma({ driverExists: false });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.suspendByFleet('ghost', new Date(), 'SOAT')).toBe(false);
    expect(holds).toHaveLength(0);
  });
});

describe('DriversService.suspendByFleetForUser · suspensión por ITV (keyeada por User.id → hold INSPECTION_EXPIRED)', () => {
  it('resuelve userId→driverId y agrega un hold INSPECTION_EXPIRED (causeRef vacío) — NO trata userId como id de perfil', async () => {
    const { prisma, holds } = makeHoldPrisma({ userId: 'user-1' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const at = new Date('2026-06-23T03:00:00.000Z');
    const applied = await svc.suspendByFleetForUser('user-1', at);
    expect(applied).toBe(true);
    expect(holds).toHaveLength(1);
    // CLAVE: el hold se ata al DRIVER cuyo userId = user-1 (driverId 'd1'), NO al userId como id de perfil.
    expect(holds[0]).toMatchObject({ driverId: 'd1', cause: 'INSPECTION_EXPIRED', causeRef: '' });
  });

  it('idempotente: cron repetido (ya hay hold ITV) → no-op false', async () => {
    const { prisma, holds } = makeHoldPrisma({
      userId: 'user-1',
      initialHolds: [hold('INSPECTION_EXPIRED', '', '2026-06-23T03:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.suspendByFleetForUser('user-1', new Date('2026-06-23T04:00:00.000Z'))).toBe(false);
    expect(holds).toHaveLength(1);
  });

  it('sin perfil (evento prematuro) → no-op false', async () => {
    const { prisma } = makeHoldPrisma({ userId: 'user-1', driverExists: false });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.suspendByFleetForUser('user-1', new Date())).toBe(false);
  });
});

describe('DriversService.suspend · suspensión MANUAL por operador (hold DISCIPLINARY)', () => {
  it('agrega un hold DISCIPLINARY, deriva suspendedAt y emite driver.suspended por outbox', async () => {
    const { prisma, holds, outbox } = makeHoldPrisma();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.suspend('d1', 'Conducta peligrosa reportada');
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ cause: 'DISCIPLINARY', causeRef: '', reason: 'Conducta peligrosa reportada' });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('driver.suspended');
    const envelope = outbox[0]?.envelope as {
      payload: { driverId: string; reason: string; suspendedAt: string };
    };
    expect(envelope.payload).toMatchObject({ driverId: 'd1', reason: 'Conducta peligrosa reportada' });
    expect(typeof envelope.payload.suspendedAt).toBe('string');
  });

  it('es idempotente: si YA tiene hold DISCIPLINARY → NO crea otro NI re-emite el evento', async () => {
    const { prisma, holds, outbox } = makeHoldPrisma({
      initialHolds: [hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.suspend('d1', 'motivo')).resolves.toBeUndefined();
    expect(holds).toHaveLength(1); // no se duplicó
    expect(outbox).toHaveLength(0); // no-op honesto: sin evento duplicado
  });

  it('conductor inexistente → NotFoundError sin crear holds ni outbox', async () => {
    const { prisma, holds, outbox } = makeHoldPrisma({ driverExists: false });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.suspend('ghost', 'motivo')).rejects.toBeInstanceOf(NotFoundError);
    expect(holds).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  // Lote 1b — ENFORCEMENT EN VIVO: suspender debe MATAR la sesión/socket vivos (revokeAllForUser), no solo
  // escribir suspendedAt. Antes la suspensión era inerte en tiempo real hasta que venciera el access token (≤15m).
  it('Lote 1b: una transición NUEVA a suspendido revoca TODAS las sesiones por userId (NO por Driver.id)', async () => {
    const { prisma } = makeHoldPrisma({ userId: 'u-driver-1' });
    const revokeAllForUser = vi.fn(async () => 0);
    const spySessions = { revokeAllForUser } as never;
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, spySessions, config);
    await svc.suspend('d1', 'Conducta peligrosa');
    expect(revokeAllForUser).toHaveBeenCalledTimes(1);
    // El filo userId ⟂ Driver.id: revokeAllForUser espera el `sub` (userId), NUNCA el id de perfil ('d1').
    expect(revokeAllForUser).toHaveBeenCalledWith('u-driver-1');
  });

  it('Lote 1b: una re-suspensión IDEMPOTENTE (el hold DISCIPLINARY ya existía) NO re-revoca', async () => {
    const { prisma } = makeHoldPrisma({
      initialHolds: [hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z')],
      userId: 'u-driver-1',
    });
    const revokeAllForUser = vi.fn(async () => 0);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, { revokeAllForUser } as never, config);
    await svc.suspend('d1', 'otra vez');
    expect(revokeAllForUser).not.toHaveBeenCalled(); // created=false → sin transición → sin revoke
  });
});

describe('DriversService.reactivate · reactivación MANUAL (quita SOLO el hold DISCIPLINARY, fail-closed)', () => {
  it('happy path: quita el hold DISCIPLINARY, deriva suspendedAt=null y emite driver.reactivated', async () => {
    const { prisma, holds, outbox } = makeHoldPrisma({
      initialHolds: [hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.reactivate('d1');
    expect(holds).toHaveLength(0); // se quitó el hold disciplinario → 0 holds → libre.
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('driver.reactivated');
    const envelope = outbox[0]?.envelope as { payload: { driverId: string; reactivatedAt: string } };
    expect(envelope.payload.driverId).toBe('d1');
  });

  it('NUNCA toca holds de documento/ITV: con DISCIPLINARY + DOCUMENT_EXPIRED, quita solo el DISCIPLINARY (sigue suspendido)', async () => {
    const { prisma, holds, deriveSuspendedAt } = makeHoldPrisma({
      initialHolds: [
        hold('DISCIPLINARY', '', '2026-06-02T00:00:00.000Z'),
        hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-01T00:00:00.000Z'),
      ],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.reactivate('d1');
    expect(holds).toHaveLength(1);
    expect(holds[0]?.cause).toBe('DOCUMENT_EXPIRED'); // el de documento INTACTO
    expect(deriveSuspendedAt()).not.toBeNull(); // SIGUE suspendido (hold de documento vigente)
  });

  it('conductor NO suspendido (0 holds) → ConflictError, sin tocar nada', async () => {
    const { prisma, holds, outbox } = makeHoldPrisma();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reactivate('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(holds).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it('suspendido SOLO por DOCUMENT_EXPIRED (sin DISCIPLINARY) → ForbiddenError (fail-closed: va por compliance)', async () => {
    const { prisma, holds, outbox } = makeHoldPrisma({
      initialHolds: [hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reactivate('d1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(holds).toHaveLength(1); // el hold de documento intacto
    expect(outbox).toHaveLength(0);
  });

  it('licencia vencida → ForbiddenError aunque tenga hold DISCIPLINARY', async () => {
    const { prisma, outbox } = makeHoldPrisma({
      initialHolds: [hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z')],
      driver: { licenseExpiresAt: new Date(Date.now() - 1_000_000) },
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reactivate('d1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(outbox).toHaveLength(0);
  });

  it('conductor inexistente → NotFoundError', async () => {
    const { prisma } = makeHoldPrisma({ driverExists: false });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reactivate('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('DriversService.reactivateByFleet · AUTO-reactivación por documento (quita SOLO ese causeRef)', () => {
  it('quita SOLO el hold DOCUMENT_EXPIRED de ESE documentType y reporta true', async () => {
    const { prisma, holds } = makeHoldPrisma({
      initialHolds: [hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.reactivateByFleet('d1', 'SOAT')).toBe(true);
    expect(holds).toHaveLength(0);
  });

  it('NO toca otro documento: regularizar SOAT con LICENSE_A1 aún vencida → queda el hold LICENSE_A1', async () => {
    const { prisma, holds } = makeHoldPrisma({
      initialHolds: [
        hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-01T00:00:00.000Z'),
        hold('DOCUMENT_EXPIRED', 'LICENSE_A1', '2026-06-02T00:00:00.000Z'),
      ],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.reactivateByFleet('d1', 'SOAT')).toBe(true);
    expect(holds).toHaveLength(1);
    expect(holds[0]?.causeRef).toBe('LICENSE_A1');
  });

  it('una DISCIPLINARY NUNCA matchea por esta vía (causa distinta) → no-op false', async () => {
    const { prisma, holds } = makeHoldPrisma({
      initialHolds: [hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.reactivateByFleet('d1', 'SOAT')).toBe(false);
    expect(holds).toHaveLength(1);
  });

  it('idempotente: hold ya regularizado (inexistente) → no-op false', async () => {
    const { prisma } = makeHoldPrisma();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.reactivateByFleet('d1', 'SOAT')).toBe(false);
  });

  it('POISON-PILL: driver INEXISTENTE (purgado/no-onboardeado) → no-op false, NO lanza (sin guard, recompute lanzaría P2025 → Kafka reintenta ∞ → bloquea la partición)', async () => {
    // El fake ahora es FIEL a la DB: tx.driver.update sobre un driver ausente lanza P2025. SIN el guard de
    // existencia, reactivateByFleet iría a removeHolds → recomputeSuspendedAt → tx.driver.update → P2025, el
    // consumer re-lanzaría y Kafka reintentaría infinito (poison-pill platform-wide). El guard lo evita.
    const { prisma, holds } = makeHoldPrisma({ driverExists: false });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reactivateByFleet('ghost', 'SOAT')).resolves.toBe(false);
    expect(holds).toHaveLength(0); // no tocó nada (no llegó a removeHolds).
  });
});

describe('DriversService.reactivateByFleetForUser · AUTO-reactivación por ITV (keyeada por User.id)', () => {
  it('resuelve userId→driverId y quita SOLO el hold INSPECTION_EXPIRED', async () => {
    const { prisma, holds } = makeHoldPrisma({
      userId: 'user-1',
      initialHolds: [hold('INSPECTION_EXPIRED', '', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.reactivateByFleetForUser('user-1')).toBe(true);
    expect(holds).toHaveLength(0);
  });

  it('NO toca un hold de documento: ITV regularizada con SOAT aún vencido → queda el hold de documento', async () => {
    const { prisma, holds } = makeHoldPrisma({
      userId: 'user-1',
      initialHolds: [
        hold('INSPECTION_EXPIRED', '', '2026-06-01T00:00:00.000Z'),
        hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-02T00:00:00.000Z'),
      ],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.reactivateByFleetForUser('user-1')).toBe(true);
    expect(holds).toHaveLength(1);
    expect(holds[0]?.cause).toBe('DOCUMENT_EXPIRED');
  });

  it('idempotente / sin perfil → no-op false', async () => {
    const { prisma } = makeHoldPrisma({ userId: 'user-1', driverExists: false });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.reactivateByFleetForUser('user-1')).toBe(false);
  });
});

describe('DriversService.reactivateForCompliance · OVERRIDE del operador (quita DOCUMENT_EXPIRED + INSPECTION_EXPIRED, fail-closed)', () => {
  it('happy path: quita TODOS los holds de doc/ITV, deriva suspendedAt=null y emite driver.reactivated', async () => {
    const { prisma, holds, outbox } = makeHoldPrisma({
      initialHolds: [
        hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-01T00:00:00.000Z'),
        hold('INSPECTION_EXPIRED', '', '2026-06-02T00:00:00.000Z'),
      ],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.reactivateForCompliance('d1');
    expect(holds).toHaveLength(0);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('driver.reactivated');
  });

  it('NUNCA toca DISCIPLINARY: con DISCIPLINARY + DOCUMENT_EXPIRED, quita solo el de doc (sigue suspendido)', async () => {
    const { prisma, holds, deriveSuspendedAt } = makeHoldPrisma({
      initialHolds: [
        hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z'),
        hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-02T00:00:00.000Z'),
      ],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.reactivateForCompliance('d1');
    expect(holds).toHaveLength(1);
    expect(holds[0]?.cause).toBe('DISCIPLINARY'); // INTACTO
    expect(deriveSuspendedAt()).not.toBeNull(); // SIGUE suspendido
  });

  it('suspendido SOLO por DISCIPLINARY → ForbiddenError (no se levanta por compliance; va por reactivate())', async () => {
    const { prisma, holds, outbox } = makeHoldPrisma({
      initialHolds: [hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reactivateForCompliance('d1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(holds).toHaveLength(1);
    expect(outbox).toHaveLength(0);
  });

  it('conductor NO suspendido (0 holds) → ConflictError', async () => {
    const { prisma } = makeHoldPrisma();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reactivateForCompliance('d1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('licencia vencida → ForbiddenError aunque la suspensión sea de compliance', async () => {
    const { prisma, outbox } = makeHoldPrisma({
      initialHolds: [hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-01T00:00:00.000Z')],
      driver: { licenseExpiresAt: new Date(Date.now() - 1_000_000) },
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reactivateForCompliance('d1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(outbox).toHaveLength(0);
  });

  it('conductor inexistente → NotFoundError', async () => {
    const { prisma } = makeHoldPrisma({ driverExists: false });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reactivateForCompliance('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('DriversService.suspendByRating · AUTO-suspensión por RATING bajo (hold RATING_LOW, decisión del dueño)', () => {
  it('agrega un hold RATING_LOW (causeRef vacío) y deriva suspendedAt', async () => {
    const { prisma, holds } = makeHoldPrisma();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const applied = await svc.suspendByRating('d1', 'Rating bajo sostenido (auto-suspensión BR-D01)');
    expect(applied).toBe(true);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ driverId: 'd1', cause: 'RATING_LOW', causeRef: '' });
  });

  it('es IDEMPOTENTE: re-flag del mismo conductor → no crea otro hold, reporta false', async () => {
    const { prisma, holds } = makeHoldPrisma({
      initialHolds: [hold('RATING_LOW', '', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const applied = await svc.suspendByRating('d1', 'otra vez');
    expect(applied).toBe(false);
    expect(holds).toHaveLength(1);
    expect(holds[0]?.createdAt).toEqual(new Date('2026-06-01T00:00:00.000Z')); // preserva el momento original.
  });

  it('conductor inexistente (flag antes del onboarding / purgado) → no-op silencioso false, sin holds (anti poison-pill)', async () => {
    const { prisma, holds } = makeHoldPrisma({ driverExists: false });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.suspendByRating('ghost', 'rating bajo')).toBe(false);
    expect(holds).toHaveLength(0);
  });

  it('COEXISTE con un DISCIPLINARY: 2 causas distintas → 2 holds (no se colapsan)', async () => {
    const { prisma, holds } = makeHoldPrisma({
      initialHolds: [hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    expect(await svc.suspendByRating('d1', 'rating bajo')).toBe(true);
    expect(holds).toHaveLength(2);
  });
});

describe('DriversService · BACKSTOP durable del revoke en las 4 vías EVENT-DRIVEN (des-gateado de created)', () => {
  // El sub-espacio del fix: cada vía event-driven (fleet doc/ITV, rating, cancelaciones) debe RESELLAR
  // `revoked:before:{userId}` INCONDICIONALMENTE (aún con created=false), al `suspendedAt` DERIVADO (no now()),
  // para que la REDELIVERY del evento gatillador cierre la crash-window si el fast-path best-effort no corrió.
  const epoch = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);
  const spy = () => ({ revokeAllForUser: vi.fn(async () => 0), resealRevokedBefore: vi.fn(async () => true) });

  it('suspendByFleet (created=true): resella por userId al epoch del suspendedAt + fast-path (revoke)', async () => {
    const { prisma } = makeHoldPrisma({ userId: 'u-doc' });
    const s = spy();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, s as never, config);
    await svc.suspendByFleet('d1', new Date('2026-06-04T10:00:00.000Z'), 'SOAT');
    // El filo userId ⟂ Driver.id: resella por el `sub` (userId), NUNCA por el id de perfil 'd1'.
    expect(s.resealRevokedBefore).toHaveBeenCalledWith('u-doc', epoch('2026-06-04T10:00:00.000Z'));
    expect(s.revokeAllForUser).toHaveBeenCalledTimes(1); // transición nueva → fast-path también
  });

  it('suspendByFleet REDELIVERY (created=false): RESELLA IGUAL (cierra crash-window) al createdAt ORIGINAL, sin fast-path', async () => {
    const { prisma } = makeHoldPrisma({
      userId: 'u-doc',
      initialHolds: [hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-01T00:00:00.000Z')],
    });
    const s = spy();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, s as never, config);
    await svc.suspendByFleet('d1', new Date('2026-06-04T10:00:00.000Z'), 'SOAT'); // created=false (ya existe)
    // DETERMINISMO: resella al momento ORIGINAL (createdAt preservado), NO al `at` de la reentrega ni a now().
    expect(s.resealRevokedBefore).toHaveBeenCalledWith('u-doc', epoch('2026-06-01T00:00:00.000Z'));
    // El fast-path SÍ se saltea (gateado en created) — es justo el hueco que el reseal incondicional cubre.
    expect(s.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('suspendByFleetForUser (ITV): resella por el userId (sub) directo', async () => {
    const { prisma } = makeHoldPrisma({ userId: 'user-1' });
    const s = spy();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, s as never, config);
    await svc.suspendByFleetForUser('user-1', new Date('2026-06-23T03:00:00.000Z'));
    expect(s.resealRevokedBefore).toHaveBeenCalledWith('user-1', epoch('2026-06-23T03:00:00.000Z'));
  });

  it('suspendByFleetForUser sin perfil: NO resella (no hay a quién revocar)', async () => {
    const { prisma } = makeHoldPrisma({ userId: 'user-1', driverExists: false });
    const s = spy();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, s as never, config);
    expect(await svc.suspendByFleetForUser('user-1', new Date())).toBe(false);
    expect(s.resealRevokedBefore).not.toHaveBeenCalled();
    expect(s.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('suspendByRating REDELIVERY (created=false): RESELLA IGUAL por userId (crash-window cerrada)', async () => {
    const { prisma } = makeHoldPrisma({
      userId: 'u-rat',
      initialHolds: [hold('RATING_LOW', '', '2026-06-01T00:00:00.000Z')],
    });
    const s = spy();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, s as never, config);
    await svc.suspendByRating('d1', 'rating bajo');
    expect(s.resealRevokedBefore).toHaveBeenCalledWith('u-rat', epoch('2026-06-01T00:00:00.000Z'));
    expect(s.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('suspendByCancellations (created=true): resella por userId al epoch del suspendedAt derivado', async () => {
    const { prisma, deriveSuspendedAt } = makeHoldPrisma({ userId: 'u-can' });
    const s = spy();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, s as never, config);
    await svc.suspendByCancellations('d1', 'exceso de cancelaciones');
    // El createdAt del hold de cancelaciones es now() del stub → tomamos el suspendedAt derivado real.
    const at = deriveSuspendedAt();
    expect(at).not.toBeNull();
    expect(s.resealRevokedBefore).toHaveBeenCalledWith('u-can', Math.floor((at as Date).getTime() / 1000));
  });

  it('suspendByRating sin perfil (purgado): NO resella (anti poison-pill, nada que revocar)', async () => {
    const { prisma } = makeHoldPrisma({ driverExists: false });
    const s = spy();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, s as never, config);
    expect(await svc.suspendByRating('ghost', 'rating bajo')).toBe(false);
    expect(s.resealRevokedBefore).not.toHaveBeenCalled();
  });

  it('propaga el error de Redis del reseal → el consumer relanza y Kafka reintenta (durabilidad)', async () => {
    const { prisma } = makeHoldPrisma({ userId: 'u-doc' });
    const s = {
      revokeAllForUser: vi.fn(async () => 0),
      resealRevokedBefore: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, s as never, config);
    await expect(svc.suspendByFleet('d1', new Date('2026-06-04T10:00:00.000Z'), 'SOAT')).rejects.toThrow(
      'redis down',
    );
  });
});

describe('DriversService.reactivateForCompliance · GENERALIZADO a TODO hold NO-DISCIPLINARY (incluye RATING_LOW)', () => {
  it('levanta un hold RATING_LOW (override del operador, reactivación MANUAL) → suspendedAt=null y emite driver.reactivated', async () => {
    const { prisma, holds, outbox } = makeHoldPrisma({
      initialHolds: [hold('RATING_LOW', '', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.reactivateForCompliance('d1');
    expect(holds).toHaveLength(0);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('driver.reactivated');
  });

  it('levanta RATING_LOW + DOCUMENT_EXPIRED + INSPECTION_EXPIRED juntos (todo lo automático), NUNCA el DISCIPLINARY', async () => {
    const { prisma, holds, deriveSuspendedAt } = makeHoldPrisma({
      initialHolds: [
        hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z'),
        hold('DOCUMENT_EXPIRED', 'SOAT', '2026-06-02T00:00:00.000Z'),
        hold('INSPECTION_EXPIRED', '', '2026-06-03T00:00:00.000Z'),
        hold('RATING_LOW', '', '2026-06-04T00:00:00.000Z'),
      ],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.reactivateForCompliance('d1');
    // Quedó SOLO la disciplinaria (intacta) → SIGUE suspendido.
    expect(holds).toHaveLength(1);
    expect(holds[0]?.cause).toBe('DISCIPLINARY');
    expect(deriveSuspendedAt()).not.toBeNull();
  });

  it('suspendido SOLO por RATING_LOW → la vía de compliance lo levanta (no es disciplinaria)', async () => {
    const { prisma, holds, deriveSuspendedAt } = makeHoldPrisma({
      initialHolds: [hold('RATING_LOW', '', '2026-06-01T00:00:00.000Z')],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.reactivateForCompliance('d1');
    expect(holds).toHaveLength(0);
    expect(deriveSuspendedAt()).toBeNull();
  });

  it('reactivate() MANUAL/disciplinaria NUNCA toca un RATING_LOW (separación de causas, fail-closed)', async () => {
    const { prisma, holds, deriveSuspendedAt } = makeHoldPrisma({
      initialHolds: [
        hold('DISCIPLINARY', '', '2026-06-01T00:00:00.000Z'),
        hold('RATING_LOW', '', '2026-06-02T00:00:00.000Z'),
      ],
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.reactivate('d1');
    // Quitó la DISCIPLINARY; el RATING_LOW queda INTACTO → SIGUE suspendido.
    expect(holds).toHaveLength(1);
    expect(holds[0]?.cause).toBe('RATING_LOW');
    expect(deriveSuspendedAt()).not.toBeNull();
  });
});

describe('Modelo de HOLDS · EL ESCENARIO DE LA CRÍTICA (multi-causa, derivación de suspendedAt)', () => {
  it('SOAT vencido + ITV vencida = 2 holds → regularizar SOLO el SOAT deja 1 hold → SIGUE suspendido; regularizar la ITV → 0 holds → LIBRE', async () => {
    const { prisma, holds, deriveSuspendedAt } = makeHoldPrisma({ userId: 'user-1' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);

    // 1) Se vencen AMBOS: SOAT (vía documento) + ITV (vía user). → 2 holds, suspendido.
    await svc.suspendByFleet('d1', new Date('2026-06-01T00:00:00.000Z'), 'SOAT');
    await svc.suspendByFleetForUser('user-1', new Date('2026-06-02T00:00:00.000Z'));
    expect(holds).toHaveLength(2);
    expect(deriveSuspendedAt()).toEqual(new Date('2026-06-01T00:00:00.000Z')); // el hold MÁS VIEJO fija el momento.

    // 2) Regulariza SOLO el SOAT. → quita 1 hold, queda la ITV → DEBE seguir suspendido (el bug viejo lo liberaba).
    expect(await svc.reactivateByFleet('d1', 'SOAT')).toBe(true);
    expect(holds).toHaveLength(1);
    expect(holds[0]?.cause).toBe('INSPECTION_EXPIRED');
    expect(deriveSuspendedAt()).not.toBeNull(); // ← LA CRÍTICA, resuelta: SIGUE SUSPENDIDO por la ITV.

    // 3) Regulariza también la ITV. → 0 holds → LIBRE.
    expect(await svc.reactivateByFleetForUser('user-1')).toBe(true);
    expect(holds).toHaveLength(0);
    expect(deriveSuspendedAt()).toBeNull(); // ← ahora SÍ se libera (0 holds).
  });

  it('una DISCIPLINARY queda INTACTA cuando se regulariza un documento', async () => {
    const { prisma, holds } = makeHoldPrisma();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.suspend('d1', 'Conducta peligrosa');
    await svc.suspendByFleet('d1', new Date('2026-06-02T00:00:00.000Z'), 'SOAT');
    expect(holds).toHaveLength(2);

    // Regularizar el SOAT (vía documento) NO debe tocar la disciplinaria.
    expect(await svc.reactivateByFleet('d1', 'SOAT')).toBe(true);
    expect(holds).toHaveLength(1);
    expect(holds[0]?.cause).toBe('DISCIPLINARY'); // ← INTACTA.
  });

  it('derivación: suspendedAt = createdAt del hold MÁS VIEJO; regularizar uno NO rejuvenece el timestamp', async () => {
    const { prisma, deriveSuspendedAt } = makeHoldPrisma();
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.suspendByFleet('d1', new Date('2026-06-01T00:00:00.000Z'), 'SOAT'); // más viejo
    await svc.suspendByFleet('d1', new Date('2026-06-10T00:00:00.000Z'), 'LICENSE_A1'); // más nuevo
    expect(deriveSuspendedAt()).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    // Regularizo el SOAT (el más viejo) → suspendedAt pasa al siguiente más viejo (la licencia), NO a null.
    await svc.reactivateByFleet('d1', 'SOAT');
    expect(deriveSuspendedAt()).toEqual(new Date('2026-06-10T00:00:00.000Z'));
  });
});

describe('DriversService.updatePersonalInfo · datos personales (BR-I04)', () => {
  /**
   * Prisma doble del UPSERT (fix P0 order-independence). `existing` simula la fila previa: null = paso 1
   * del wizard SIN fila Driver (caso que antes daba 404). El doble captura el branch usado (create/update)
   * y refleja en el resultado el merge de la fila previa con los datos enviados (mapeo dni→document_id),
   * para verificar tanto la vista devuelta como la materialización del cascarón.
   */
  function makePersonalPrisma(
    existing: Record<string, unknown> | null,
    /**
     * Filas de OTROS conductores ya persistidas (userId + dniHash), para simular el choque del blind
     * index. Vacío por default: los tests que no ejercitan la unicidad del DNI no ven ningún clash.
     */
    others: { userId: string; dniHash: string }[] = [],
  ) {
    const upsertCalls: {
      create: Record<string, unknown>;
      update?: Record<string, unknown>;
    }[] = [];
    const outboxEvents: { aggregateId: string; eventType: string }[] = [];
    return {
      upsertCalls,
      outboxEvents,
      prisma: {
        read: {
          driver: {
            findUnique: async () => existing,
            // Espeja el pre-check (y el backstop de carrera) de `updatePersonalInfo`/`dniExists`:
            // matchea la primera fila de OTRO userId con el MISMO dniHash.
            findFirst: async ({
              where,
            }: {
              where: { dniHash: string; NOT: { userId: string } };
            }) => {
              const match = others.find(
                (o) => o.dniHash === where.dniHash && o.userId !== where.NOT.userId,
              );
              return match ? { id: `clash-${match.userId}` } : null;
            },
          },
        },
        // Materialización por `materializeDriverShell`: createMany({skipDuplicates}) → si la fila ya existía
        // (existing) el count es 0 (no crea, no emite) y se actualiza el slice; si no existía, count 1 (crea +
        // emite driver.registered). El doble captura ambos brazos en `upsertCalls` (create del createMany,
        // update del driver.update) + los eventos de outbox para fijar el invariante exactly-once.
        write: {
          // Gate A10: `updatePersonalInfo` lee el backgroundCheckStatus de la PRIMARIA (no la réplica) ANTES de
          // materializar, para bloquear el cambio de PII con el alta ya aprobada (CLEARED). El doble sirve la
          // MISMA fila `existing` (null si el conductor aún no existe → gate pasa): fiel a que el gate mira el
          // estado REAL de la fila, no un valor fijo.
          driver: {
            findUnique: async () => existing,
          },
          $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
            const call: { create: Record<string, unknown>; update?: Record<string, unknown> } = {
              create: {},
            };
            const tx = {
              driver: {
                createMany: async ({ data }: { data: Record<string, unknown> }) => {
                  call.create = data;
                  return { count: existing ? 0 : 1 };
                },
                update: async ({ data }: { data: Record<string, unknown> }) => {
                  call.update = data;
                  return {};
                },
                // CAS del gate A10 (rama update de materializeDriverShell con guard): aplica SOLO si la fila
                // existe y el guard `backgroundCheckStatus.not` NO iguala el estado real (fiel al WHERE del
                // updateMany). Simula la carrera: un approve() que dejó CLEARED → count 0 → InvalidStateError.
                updateMany: async ({
                  where,
                  data,
                }: {
                  where: { userId: string; backgroundCheckStatus?: { not?: string } };
                  data: Record<string, unknown>;
                }) => {
                  const notStatus = where.backgroundCheckStatus?.not;
                  const rowStatus = existing?.backgroundCheckStatus as string | undefined;
                  if (existing != null && (notStatus === undefined || rowStatus !== notStatus)) {
                    call.update = data;
                    return { count: 1 };
                  }
                  return { count: 0 };
                },
                findUniqueOrThrow: async () => {
                  const data = existing ? { ...existing, ...(call.update ?? {}) } : call.create;
                  return {
                    id: (data.id as string) ?? 'd-new',
                    backgroundCheckStatus: (data.backgroundCheckStatus as string) ?? 'PENDING',
                    legalName: (data.legalName as string | null) ?? null,
                    documentIdEnc: (data.documentIdEnc as string | null) ?? null,
                    birthDate: (data.birthDate as Date | null) ?? null,
                  };
                },
              },
              outboxEvent: {
                create: async ({
                  data,
                }: {
                  data: { aggregateId: string; eventType: string };
                }) => {
                  outboxEvents.push({ aggregateId: data.aggregateId, eventType: data.eventType });
                },
              },
            };
            const result = await fn(tx);
            upsertCalls.push(call);
            return result;
          },
        },
      },
    };
  }

  it('NO devuelve el DNI crudo al conductor: lo enmascara (últimos 4) en la vista (PII Ley 29733)', async () => {
    // El conductor edita su PII durante el alta → backgroundCheckStatus PENDING (el gate A10 solo bloquea CLEARED).
    const { prisma } = makePersonalPrisma({ ...okDriver, backgroundCheckStatus: 'PENDING' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const { prisma, upsertCalls } = makePersonalPrisma({
      ...okDriver,
      legalName: 'Ana',
      backgroundCheckStatus: 'PENDING',
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const input = { legalName: 'Ana María', dni: '87654321', birthDate: '1992-01-10' };
    await svc.updatePersonalInfo('u1', input);
    await svc.updatePersonalInfo('u1', input);
    // Dos upsert al MISMO unique userId: idempotente, sin error de conflicto.
    expect(upsertCalls).toHaveLength(2);
  });

  it('exactly-once: SIN fila previa emite driver.registered (una vez); con fila previa NO re-emite', async () => {
    // personal-first crea el cascarón → emite el evento de registro EN la misma tx (outbox-in-tx).
    const first = makePersonalPrisma(null);
    const svcA = new DriversService(first.prisma as never, makeRedis() as never, bio, sessions, config);
    await svcA.updatePersonalInfo('u1', { legalName: 'Ana', dni: '87654321', birthDate: '1992-01-10' });
    expect(first.outboxEvents.map((e) => e.eventType)).toEqual(['driver.registered']);
    // La fila ya existía (el OTRO paso del wizard la creó y ya emitió) → este no re-emite (count 0).
    const second = makePersonalPrisma({ ...okDriver, legalName: 'Ana', backgroundCheckStatus: 'PENDING' });
    const svcB = new DriversService(second.prisma as never, makeRedis() as never, bio, sessions, config);
    await svcB.updatePersonalInfo('u1', {
      legalName: 'Ana María',
      dni: '87654321',
      birthDate: '1992-01-10',
    });
    expect(second.outboxEvents).toHaveLength(0);
  });

  it('GATE A10: un conductor CLEARED (alta aprobada) NO puede reescribir su PII → InvalidStateError, CERO escrituras', async () => {
    // Invariante KYC "identidad operada == identidad revisada" (Ley 29733): con el alta aprobada (CLEARED) el
    // conductor NO cambia su identidad por autoservicio (operaría bajo una identidad distinta a la revisada). La
    // máquina prohíbe CLEARED→PENDING, así que el gate corta ANTES de materializar (no hay auto-re-review).
    const { prisma, upsertCalls } = makePersonalPrisma({ ...okDriver, backgroundCheckStatus: 'CLEARED' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(
      svc.updatePersonalInfo('u1', { legalName: 'Otro Nombre', dni: '87654321', birthDate: '1990-05-20' }),
    ).rejects.toBeInstanceOf(InvalidStateError);
    // Fail-closed: el gate corta ANTES de la materialización → no se escribió nada.
    expect(upsertCalls).toHaveLength(0);
  });

  it('A10 · RESET DEL BINDING: cambiar la PII (PENDING) nulifica el cotejo face-match del ciclo en curso (updateData)', async () => {
    // Cambiar la identidad invalida cualquier binding face-match que apuntaba al DNI VIEJO. El updateData que va
    // a materializeDriverShell (brazo update, la fila ya existía) DEBE limpiar los 6 campos del binding para
    // OBLIGAR a re-cotejar; sin esto, approve() (gate `dniFaceMatchedAt != null`) pasaría con un cotejo STALE.
    const { prisma, upsertCalls } = makePersonalPrisma({
      ...okDriver,
      backgroundCheckStatus: 'PENDING',
      dniFaceMatchedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.updatePersonalInfo('u1', { legalName: 'Ana', dni: '87654321', birthDate: '1992-01-10' });
    // La fila ya existía → brazo update; el updateData resetea el binding (los 6 campos juntos, coherencia atómica).
    expect(upsertCalls[0]?.update).toMatchObject({
      dniFaceMatched: null,
      dniFaceMatchScore: null,
      dniFaceMatchedAt: null,
      licenseFaceMatched: null,
      licenseFaceMatchScore: null,
      licenseFaceMatchedAt: null,
    });
  });

  describe('blind index del DNI (dni_hash) · unicidad sin exponer la PII', () => {
    it('DNI nuevo (sin choque): crea OK y escribe el dniHash determinista en la fila', async () => {
      const { prisma, upsertCalls } = makePersonalPrisma(null);
      const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
      const dni = '11112222';
      await svc.updatePersonalInfo('u1', { legalName: 'Ana', dni, birthDate: '1992-01-10' });
      expect(upsertCalls[0]?.create.dniHash).toBe(hashPii(dni, DNI_HASH_SALT));
    });

    it('DNI de OTRO conductor (choque de blind index): lanza DniAlreadyRegisteredError (409) y NO persiste', async () => {
      const dni = '99998888';
      const otherDniHash = hashPii(dni, DNI_HASH_SALT);
      const { prisma, upsertCalls } = makePersonalPrisma(null, [
        { userId: 'u-other', dniHash: otherDniHash },
      ]);
      const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
      await expect(
        svc.updatePersonalInfo('u1', { legalName: 'Ana', dni, birthDate: '1992-01-10' }),
      ).rejects.toThrow(DniAlreadyRegisteredError);
      // El pre-check corta ANTES de la materialización: no se llega a escribir nada.
      expect(upsertCalls).toHaveLength(0);
    });

    it('MISMO userId re-envía SU PROPIO DNI (resume del wizard): el pre-check lo EXCLUYE, NO lanza', async () => {
      const dni = '12345678';
      const ownDniHash = hashPii(dni, DNI_HASH_SALT);
      // La única fila con ese dniHash es la del PROPIO u1 (no aparece en `others`, que solo modela
      // choques de OTROS userId): el `NOT: { userId }` del pre-check la excluye del match.
      const { prisma } = makePersonalPrisma(
        { ...okDriver, userId: 'u1', dniHash: ownDniHash, backgroundCheckStatus: 'PENDING' },
        [],
      );
      const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
      await expect(
        svc.updatePersonalInfo('u1', { legalName: 'Ana María', dni, birthDate: '1992-01-10' }),
      ).resolves.not.toThrow();
    });
  });

  describe('DriversService.dniExists · check-dni previo al alta (F0: escaneo del DNI)', () => {
    it('true cuando el DNI YA pertenece a OTRA cuenta de conductor', async () => {
      const dni = '55556666';
      const { prisma } = makePersonalPrisma(null, [
        { userId: 'u-other', dniHash: hashPii(dni, DNI_HASH_SALT) },
      ]);
      const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
      expect(await svc.dniExists('u1', dni)).toBe(true);
    });

    it('false cuando NINGÚN otro conductor tiene ese DNI', async () => {
      const { prisma } = makePersonalPrisma(null, []);
      const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
      expect(await svc.dniExists('u1', '77778888')).toBe(false);
    });

    it('false cuando el ÚNICO dueño del hash es el PROPIO userId (excluido por NOT)', async () => {
      const dni = '12345678';
      const { prisma } = makePersonalPrisma(null, [
        { userId: 'u1', dniHash: hashPii(dni, DNI_HASH_SALT) },
      ]);
      const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
      expect(await svc.dniExists('u1', dni)).toBe(false);
    });
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
      update?: Record<string, unknown>;
    }[] = [];
    const outboxEvents: { aggregateId: string; eventType: string }[] = [];
    return {
      upsertCalls,
      outboxEvents,
      prisma: {
        read: {
          user: { findUnique: async () => user },
          driver: { findUnique: async () => existing },
        },
        // Mismo doble de materialización que `makePersonalPrisma`: el count del createMany discrimina
        // crear+emitir (sin fila previa) de solo-actualizar (cascarón ya creado por el otro paso del wizard).
        write: {
          $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
            const call: { create: Record<string, unknown>; update?: Record<string, unknown> } = {
              create: {},
            };
            const tx = {
              driver: {
                createMany: async ({ data }: { data: Record<string, unknown> }) => {
                  call.create = data;
                  return { count: existing ? 0 : 1 };
                },
                update: async ({ data }: { data: Record<string, unknown> }) => {
                  call.update = data;
                  return {};
                },
                findUniqueOrThrow: async () => {
                  const data = existing ? { ...existing, ...(call.update ?? {}) } : call.create;
                  return {
                    id: (data.id as string) ?? 'd-new',
                    backgroundCheckStatus: (data.backgroundCheckStatus as string) ?? 'PENDING',
                  };
                },
              },
              outboxEvent: {
                create: async ({
                  data,
                }: {
                  data: { aggregateId: string; eventType: string };
                }) => {
                  outboxEvents.push({ aggregateId: data.aggregateId, eventType: data.eventType });
                },
              },
            };
            const result = await fn(tx);
            upsertCalls.push(call);
            return result;
          },
        },
      },
    };
  }

  const license = { licenseNumber: 'L-123', licenseExpiresAt: futureLicense.toISOString() };

  it('onboard-first: SIN fila previa crea el cascarón con la licencia y queda PENDING', async () => {
    const { prisma, upsertCalls } = makeOnboardPrisma(null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const out = await svc.onboard('u1', license);
    expect(out).toEqual({ driverId: 'd1', backgroundCheckStatus: 'PENDING' });
    // Solo actualiza el slice de licencia: no pisa otros campos del agregado.
    expect(upsertCalls[0]?.update).toEqual({ licenseNumber: 'L-123', licenseExpiresAt: futureLicense });
  });

  it('re-submit idempotente: onboard dos veces no rompe ni duplica (upsert por userId)', async () => {
    const { prisma, upsertCalls } = makeOnboardPrisma({ id: 'd1', backgroundCheckStatus: 'PENDING' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.onboard('u1', license);
    await svc.onboard('u1', license);
    expect(upsertCalls).toHaveLength(2);
  });

  it('exactly-once: onboard-first emite driver.registered; onboard-after-personal NO re-emite', async () => {
    // onboard-first crea el cascarón → emite el evento de registro (aggregateId = id del Driver).
    const first = makeOnboardPrisma(null);
    const svcA = new DriversService(first.prisma as never, makeRedis() as never, bio, sessions, config);
    await svcA.onboard('u1', license);
    expect(first.outboxEvents.map((e) => e.eventType)).toEqual(['driver.registered']);
    expect(first.outboxEvents[0]?.aggregateId).toBe('d-new');
    // Cascarón ya creado por updatePersonalInfo (existing) → solo fija la licencia, sin re-emitir.
    const second = makeOnboardPrisma({ id: 'd1', backgroundCheckStatus: 'PENDING' });
    const svcB = new DriversService(second.prisma as never, makeRedis() as never, bio, sessions, config);
    await svcB.onboard('u1', license);
    expect(second.outboxEvents).toHaveLength(0);
  });

  it('rechaza si el usuario no existe o está borrado (404)', async () => {
    const { prisma } = makeOnboardPrisma(null, null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.onboard('u1', license)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rechaza si el usuario no es conductor (403)', async () => {
    const { prisma } = makeOnboardPrisma(null, { id: 'u1', type: 'PASSENGER', deletedAt: null });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.onboard('u1', license)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('DriversService.setStatus · transición de turno validada por la máquina', () => {
  /** Prisma doble que refleja el currentStatus escrito (para verificar qué se persistió). */
  function makeStatusPrisma(driver: unknown) {
    const writes: Record<string, unknown>[] = [];
    const outbox: Record<string, unknown>[] = [];
    // Fase B (ADR-021) + A8 — setStatus ahora transiciona por CAS ATÓMICO (`updateMany` con
    // `currentStatus in driverStatusSources(status)` en el WHERE) + outbox del `driver.went_offline` al pasar a
    // OFFLINE. El doble evalúa el WHERE de VERDAD contra el `currentStatus` de la fila simulada: matchea (count 1)
    // SOLO si el estado actual es una fuente legal del destino; si no (carrera que movió la fila), count 0 y el
    // servicio relee vía `findUnique`. Así el CAS del test es real, no un `count:1` a ciegas.
    const tx = {
      driver: {
        updateMany: async ({
          where,
          data,
        }: {
          where: { currentStatus?: { in: string[] } };
          data: Record<string, unknown>;
        }) => {
          const current = (driver as { currentStatus?: string })?.currentStatus;
          const sources = where.currentStatus?.in ?? [];
          const matches = current != null && sources.includes(current);
          if (matches) writes.push(data);
          return { count: matches ? 1 : 0 };
        },
        findUnique: async () => driver,
      },
      outboxEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          outbox.push(data);
        },
      },
    };
    return {
      writes,
      outbox,
      prisma: {
        read: { driver: { findUnique: async () => driver } },
        write: {
          driver: {
            update: async ({ data }: { data: Record<string, unknown> }) => {
              writes.push(data);
              return { currentStatus: data.currentStatus };
            },
          },
          $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
        },
      },
    };
  }

  it('permite el fin de turno AVAILABLE → OFFLINE', async () => {
    const { prisma } = makeStatusPrisma({ ...okDriver, currentStatus: 'AVAILABLE' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.setStatus('u1', 'OFFLINE')).resolves.toEqual({ status: 'OFFLINE' });
  });

  it('Fase B · el fin de turno OFFLINE emite driver.went_offline (reason=shift_end) por outbox', async () => {
    const { prisma, outbox } = makeStatusPrisma({ ...okDriver, id: 'drv-1', currentStatus: 'AVAILABLE' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.setStatus('u1', 'OFFLINE');
    expect(outbox).toHaveLength(1);
    const entry = outbox[0]!;
    expect(entry).toMatchObject({ aggregateId: 'drv-1', eventType: 'driver.went_offline' });
    const env = entry.envelope as { payload: { driverId: string; reason: string } };
    expect(env.payload).toMatchObject({ driverId: 'drv-1', reason: 'shift_end' });
  });

  it('Fase B · la pausa ON_BREAK NO emite driver.went_offline (sigue en turno, online)', async () => {
    const { prisma, outbox } = makeStatusPrisma({ ...okDriver, currentStatus: 'AVAILABLE' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.setStatus('u1', 'ON_BREAK')).resolves.toEqual({ status: 'ON_BREAK' });
    expect(outbox).toHaveLength(0);
  });

  it('un SUSPENDED NO puede auto-ponerse AVAILABLE ni saltándose el tipo (409, no escribe)', async () => {
    // AVAILABLE ya NI compila como SelfServiceDriverStatus (gate compile-time del retoque);
    // el cast simula un bypass del tipo para fijar que la máquina sigue rechazando en runtime.
    const { prisma, writes } = makeStatusPrisma({ ...okDriver, currentStatus: 'SUSPENDED' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.setStatus('u1', 'AVAILABLE' as never)).rejects.toBeInstanceOf(
      InvalidStatusTransition,
    );
    expect(writes).toHaveLength(0);
  });

  it('no hay pausa sin turno: OFFLINE → ON_BREAK es inválida', async () => {
    const { prisma } = makeStatusPrisma({ ...okDriver, currentStatus: 'OFFLINE' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.setStatus('u1', 'ON_BREAK')).rejects.toBeInstanceOf(InvalidStatusTransition);
  });

  it('currentStatus legacy fuera del enum → 409 fail-closed, nunca TypeError', async () => {
    const { prisma } = makeStatusPrisma({ ...okDriver, currentStatus: 'LEGACY_GARBAGE' });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    // approve() Y reject() transicionan AMBOS por CAS atómico (A6): `updateMany({ where: { backgroundCheckStatus
    // in <sources> } })` — approve con sources={PENDING,REJECTED}, reject con sources={PENDING,CLEARED} (derivadas
    // de la máquina, cada una excluye su propio destino). El doble evalúa el WHERE de VERDAD contra el estado
    // FRESCO de la tx: matchea (count 1) SOLO si el estado fuente actual está en el `in` del WHERE — así el CAS
    // discrimina al perdedor de la carrera (un CLEARED fuera del `in` de approve, un REJECTED fuera del `in` de
    // reject) sin `count:1` a ciegas. approve además pliega el binding face-match (`dniFaceMatchedAt/
    // licenseFaceMatchedAt: { not: null }`): si una tx concurrente lo nulificó, la fila fresca ya no matchea.
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
            licenseFaceMatchedAt?: { not: null };
          };
          data: Record<string, unknown>;
        }) => {
          const fresh = txDriver as {
            backgroundCheckStatus?: string;
            dniFaceMatchedAt?: Date | null;
            licenseFaceMatchedAt?: Date | null;
          };
          const current = fresh?.backgroundCheckStatus;
          // (1) El estado fuente fresco DEBE estar en el `in` del WHERE (la fuente única de verdad del CAS: no
          // hardcodeamos qué estados — leemos el `where.in` que armó el servicio desde la máquina).
          const sourceMatches =
            current != null && (where.backgroundCheckStatus?.in.includes(current) ?? false);
          // (2) approve pliega el binding en el WHERE. `casDniFaceMatchedAt` permite que el CAS vea un binding
          // DISTINTO al del pre-read (la nulificación aterriza estrictamente entre ambos); sin override, ve el
          // mismo binding que la tx. reject NO manda estas cláusulas (undefined) → no gatean.
          const casMatchedAt =
            'casDniFaceMatchedAt' in overrides ? overrides.casDniFaceMatchedAt : fresh?.dniFaceMatchedAt;
          const bindingFresh = where.dniFaceMatchedAt === undefined || casMatchedAt != null;
          const licenseFresh =
            where.licenseFaceMatchedAt === undefined || fresh?.licenseFaceMatchedAt != null;
          const matches = sourceMatches && bindingFresh && licenseFresh;
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
  });

  it('GATE BIOMÉTRICO: rechaza la aprobación con 409 si faceEmbedding es null (nunca enroló)', async () => {
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING', faceEmbedding: null },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
  });

  it('GATE FACE-MATCH licencia (Lote C): rechaza con 409 si el DNI se ejecutó pero la LICENCIA no (licenseFaceMatchedAt=null)', async () => {
    // El gate de licencia muerde INDEPENDIENTE del DNI: aunque el binding del DNI esté corrido, sin el cotejo
    // del brevete (licenseFaceMatchedAt=null) NO se aprueba. Curl-proof, fail-closed, cero escrituras.
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      {
        ...okDriver,
        backgroundCheckStatus: 'PENDING',
        dniFaceMatchedAt: new Date('2026-01-01T00:00:00Z'),
        licenseFaceMatched: null,
        licenseFaceMatchedAt: null,
      },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
  });

  it('GATE LIVENESS PASIVO: rechaza con 409 si el PAD NO se ejecutó — null (NOT_RUN) y false (DEGRADED)', async () => {
    // Gate de EJECUCIÓN del anti-spoofing: con los face-match corridos PERO el PAD sin correr (livenessChecked
    // null = enrol previo al campo, o false = modelo ausente → degradado), NO se aprueba. Un spoof no llega acá
    // (se rechaza en el enrol). Curl-proof, fail-closed, cero escrituras. Ambos no-PASSED bloquean.
    for (const livenessChecked of [null, false] as const) {
      const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
        { ...okDriver, backgroundCheckStatus: 'PENDING', livenessChecked },
        { id: 'u1', kycStatus: 'PENDING' },
      );
      const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
      await expect(svc.approve('d1')).rejects.toBeInstanceOf(ConflictError);
      expect(driverWrites).toHaveLength(0);
      expect(userWrites).toHaveLength(0);
    }
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.approve('d1');
    expect(driverWrites).toEqual([{ backgroundCheckStatus: 'CLEARED' }]);
  });

  it('backgroundCheckStatus legacy fuera del enum → 409 fail-closed sin escribir', async () => {
    const { prisma, driverWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'LEGACY_GARBAGE' },
      { id: 'u1', kycStatus: 'PENDING' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.approve('d1')).rejects.toBeInstanceOf(InvalidStatusTransition);
    expect(driverWrites).toHaveLength(0);
  });

  it('rechaza un CLEARED (revocación por hallazgo posterior): CLEARED → REJECTED es válida', async () => {
    const { prisma, driverWrites, userWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'CLEARED' },
      { id: 'u1', kycStatus: 'VERIFIED' },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reject('d1', 'motivo')).rejects.toBeInstanceOf(InvalidStatusTransition);
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
  });

  it('reject concurrente que ya dejó REJECTED: no-op idempotente por CAS (A6) — NO reescribe NI re-emite', async () => {
    // CONTRATO NUEVO (A6): reject transiciona por CAS. `rejectSources`={PENDING,CLEARED} EXCLUYE el destino
    // REJECTED, así que si la fila FRESCA ya está REJECTED (otra decisión concurrente ganó) el WHERE no matchea
    // (count 0). El servicio relee, ve REJECTED y devuelve idempotente SIN reescribir la fila, SIN re-tocar el
    // KYC del usuario y SIN re-emitir driver.rejected (cero double-emit). Antes (update plano) re-escribía a
    // ciegas; ahora el CAS discrimina al perdedor de la carrera.
    const { prisma, driverWrites, userWrites, outbox } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
      {
        txDriver: { ...okDriver, backgroundCheckStatus: 'REJECTED' },
        txUser: { id: 'u1', kycStatus: 'REJECTED' },
      },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reject('d1', 'motivo')).resolves.toBeUndefined();
    // No-op honesto: el CAS no matcheó (ya estaba REJECTED) → cero escrituras y cero eventos.
    expect(driverWrites).toHaveLength(0);
    expect(userWrites).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it('reject: 404 si el conductor no existe (la lectura vive dentro de la tx)', async () => {
    const { prisma, driverWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
      { txDriver: null },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reject('d1', 'motivo')).rejects.toBeInstanceOf(NotFoundError);
    expect(driverWrites).toHaveLength(0);
  });

  it('reject: 404 si el usuario del conductor no existe (la lectura vive dentro de la tx)', async () => {
    const { prisma, driverWrites } = makeApprovalPrisma(
      { ...okDriver, backgroundCheckStatus: 'PENDING' },
      { id: 'u1', kycStatus: 'PENDING' },
      { txUser: null },
    );
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(svc.reject('d1', 'motivo')).rejects.toBeInstanceOf(NotFoundError);
    expect(driverWrites).toHaveLength(0);
  });
});

describe('DriversService.matchDniFace · BINDING DNI↔selfie (sub-lote 3C)', () => {
  /** Prisma que captura el `data` del driver.update (en la tx del match) + sirve el autoVerify del KYC. */
  function makeMatchPrisma(driver: unknown, kycStatus: string = 'PENDING') {
    const updates: {
      dniFaceMatched?: boolean;
      dniFaceMatchScore?: number;
      dniFaceMatchedAt?: Date;
    }[] = [];
    const userUpdates: Record<string, unknown>[] = [];
    const events: string[] = [];
    return {
      updates,
      userUpdates,
      events,
      read: { driver: { findUnique: async () => driver } },
      write: {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            driver: {
              update: async (args: { data: (typeof updates)[number] }) => {
                updates.push(args.data);
                return {};
              },
              findUnique: async () => driver,
            },
            user: {
              findUnique: async () => ({ kycStatus }),
              update: async (args: { data: Record<string, unknown> }) => {
                userUpdates.push(args.data);
                return {};
              },
            },
            outboxEvent: {
              create: async (args: { data: { eventType: string } }) => {
                events.push(args.data.eventType);
                return {};
              },
            },
          }),
      },
    };
  }

  it('corre el match contra el embedding GUARDADO y PERSISTE el resultado (matched/score/at)', async () => {
    const prisma = makeMatchPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(
      svc.matchDniFace('d1', { image: 'base64-dni-front' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.updates).toHaveLength(0);
  });

  it('404 si el conductor no existe', async () => {
    const prisma = makeMatchPrisma(null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
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
    const svc = new DriversService(prisma as never, makeRedis() as never, bioNoMatch, sessions, config);
    const out = await svc.matchDniFace('d1', { image: 'base64-dni-front' });
    expect(out.matched).toBe(false);
    expect(prisma.updates[0]?.dniFaceMatched).toBe(false);
    expect(prisma.updates[0]?.dniFaceMatchScore).toBe(33);
  });
});

describe('DriversService.matchLicenseFace · BINDING licencia↔selfie (Lote C)', () => {
  /** Prisma que captura el `data` del driver.update (en la tx del match) + sirve el autoVerify del KYC. */
  function makeMatchPrisma(driver: unknown, kycStatus: string = 'PENDING') {
    const updates: {
      licenseFaceMatched?: boolean;
      licenseFaceMatchScore?: number;
      licenseFaceMatchedAt?: Date;
    }[] = [];
    const userUpdates: Record<string, unknown>[] = [];
    const events: string[] = [];
    return {
      updates,
      userUpdates,
      events,
      read: { driver: { findUnique: async () => driver } },
      write: {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            driver: {
              update: async (args: { data: (typeof updates)[number] }) => {
                updates.push(args.data);
                return {};
              },
              findUnique: async () => driver,
            },
            user: {
              findUnique: async () => ({ kycStatus }),
              update: async (args: { data: Record<string, unknown> }) => {
                userUpdates.push(args.data);
                return {};
              },
            },
            outboxEvent: {
              create: async (args: { data: { eventType: string } }) => {
                events.push(args.data.eventType);
                return {};
              },
            },
          }),
      },
    };
  }

  it('corre el match del brevete contra el embedding GUARDADO y PERSISTE los campos licenseFace*', async () => {
    const prisma = makeMatchPrisma(okDriver);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    const out = await svc.matchLicenseFace('d1', { image: 'base64-license-front' });
    expect(out).toEqual({ matched: true, score: 96, reason: null });
    // GUARDA en los campos de LICENCIA (no en los del DNI): veredicto + score + momento, una sola escritura.
    expect(prisma.updates).toHaveLength(1);
    const [persisted] = prisma.updates;
    expect(persisted?.licenseFaceMatched).toBe(true);
    expect(persisted?.licenseFaceMatchScore).toBe(96);
    expect(persisted?.licenseFaceMatchedAt).toBeInstanceOf(Date);
  });

  it('sin biometría enrolada → 409 (ConflictError) y NO escribe nada', async () => {
    const prisma = makeMatchPrisma({ ...okDriver, faceEmbedding: [] });
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(
      svc.matchLicenseFace('d1', { image: 'base64-license-front' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.updates).toHaveLength(0);
  });

  it('404 si el conductor no existe', async () => {
    const prisma = makeMatchPrisma(null);
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await expect(
      svc.matchLicenseFace('d1', { image: 'base64-license-front' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.updates).toHaveLength(0);
  });

  it('NO coincide (brevete low-res) → persiste licenseFaceMatched=false con score y motivo', async () => {
    const prisma = makeMatchPrisma(okDriver);
    const bioNoMatch = {
      ...bio,
      async matchDniFace() {
        return { matched: false, score: 28, reason: 'no coincide' };
      },
    };
    const svc = new DriversService(prisma as never, makeRedis() as never, bioNoMatch, sessions, config);
    const out = await svc.matchLicenseFace('d1', { image: 'base64-license-front' });
    expect(out.matched).toBe(false);
    expect(prisma.updates[0]?.licenseFaceMatched).toBe(false);
    expect(prisma.updates[0]?.licenseFaceMatchScore).toBe(28);
  });

  // ── AUTO-VERIFICACIÓN del KYC (desacople de la aprobación) ──
  it('AUTO-VERIFICA el KYC (PENDING → VERIFIED + outbox user.kyc_verified) cuando liveness PASÓ + ambos matches COINCIDEN', async () => {
    // okDriver tiene livenessChecked=true + dniFaceMatched=true; este match de licencia COINCIDE → set completo.
    const prisma = makeMatchPrisma(okDriver, 'PENDING');
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.matchLicenseFace('d1', { image: 'base64-license-front' });
    expect(prisma.userUpdates).toHaveLength(1);
    expect(prisma.userUpdates[0]?.kycStatus).toBe('VERIFIED');
    expect(prisma.userUpdates[0]?.kycVerifiedAt).toBeInstanceOf(Date);
    expect(prisma.events).toContain('user.kyc_verified');
  });

  it('NO auto-verifica el KYC si el match del brevete NO coincide (identidad dudosa → queda PENDING, lo decide el operador)', async () => {
    // Estado post-match con la licencia en NO_MATCH (el findUnique del autoVerify lo refleja).
    const prisma = makeMatchPrisma({ ...okDriver, licenseFaceMatched: false }, 'PENDING');
    const bioNoMatch = {
      ...bio,
      async matchDniFace() {
        return { matched: false, score: 28, reason: 'no coincide' };
      },
    };
    const svc = new DriversService(prisma as never, makeRedis() as never, bioNoMatch, sessions, config);
    await svc.matchLicenseFace('d1', { image: 'base64-license-front' });
    expect(prisma.userUpdates).toHaveLength(0);
    expect(prisma.events).toHaveLength(0);
  });

  it('IDEMPOTENTE: si el KYC ya está VERIFIED no re-transiciona ni re-emite', async () => {
    const prisma = makeMatchPrisma(okDriver, 'VERIFIED');
    const svc = new DriversService(prisma as never, makeRedis() as never, bio, sessions, config);
    await svc.matchLicenseFace('d1', { image: 'base64-license-front' });
    expect(prisma.userUpdates).toHaveLength(0);
    expect(prisma.events).toHaveLength(0);
  });
});

describe('DriversService · techo de abuso del enrol + destrabe de central (F3)', () => {
  /** Redis stateful POR-CLAVE (el makeRedis global es shift-specific): modela el cooldown de spoof del enrol. */
  function makeKeyedRedis(seed: Record<string, number> = {}) {
    const counts = new Map<string, number>(Object.entries(seed));
    return {
      counts,
      async get(key: string): Promise<string | null> {
        const v = counts.get(key);
        return v === undefined ? null : String(v);
      },
      async incr(key: string): Promise<number> {
        const v = (counts.get(key) ?? 0) + 1;
        counts.set(key, v);
        return v;
      },
      async expire(): Promise<number> {
        return 1;
      },
      // Simula el script Lua FIXED_WINDOW_INCR_EXPIRE de `consumeFixedWindow`: INCR de la key + PEXPIRE en el
      // primer hit; devuelve [count, ttl]. Comparte el mismo `counts` que get/incr/del (coherencia del contador).
      async eval(_script: string, _numKeys: number, key: string, windowMs: number): Promise<[number, number]> {
        const v = (counts.get(key) ?? 0) + 1;
        counts.set(key, v);
        return [v, windowMs];
      },
      async del(key: string): Promise<number> {
        return counts.delete(key) ? 1 : 0;
      },
    };
  }

  /** Prisma mínimo para enrollFace (findUnique por userId) que captura el outbox; reusa el patrón del bloque enrol. */
  function makeEnrollPrismaLocal(driver: unknown) {
    const driverWrite = { update: async () => ({}) };
    const outboxEvent = { create: async () => ({}) };
    return {
      read: { driver: { findUnique: async () => driver } },
      write: {
        driver: driverWrite,
        outboxEvent,
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ driver: driverWrite, outboxEvent }),
      },
    };
  }

  const ENROLL_KEY = 'veo:bio:enroll-spoof:d1';
  const SHIFT_KEY = 'veo:bio:fails:d1';

  it('GATE DE ABUSO: con el cooldown lleno (5 spoofs) → 403 ANTES de gastar el PAD', async () => {
    const redis = makeKeyedRedis({ [ENROLL_KEY]: 5 });
    // Si el gate NO cortara, bioSpoof tiraría Unprocessable (422). Que tire Forbidden (403) PRUEBA el short-circuit.
    const svc = new DriversService(
      makeEnrollPrismaLocal(okDriver) as never,
      redis as never,
      bioSpoof,
      sessions,
      config,
    );
    await expect(svc.enrollFace('u1', { photo: 'selfie' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('un SPOOF incrementa el contador de abuso del enrol', async () => {
    const redis = makeKeyedRedis();
    const svc = new DriversService(
      makeEnrollPrismaLocal(okDriver) as never,
      redis as never,
      bioSpoof,
      sessions,
      config,
    );
    await expect(svc.enrollFace('u1', { photo: 'selfie' })).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(redis.counts.get(ENROLL_KEY)).toBe(1);
  });

  it('un enrol OK LIMPIA el contador de abuso (no arrastra spoofs viejos)', async () => {
    const redis = makeKeyedRedis({ [ENROLL_KEY]: 3 });
    const svc = new DriversService(
      makeEnrollPrismaLocal(okDriver) as never,
      redis as never,
      bio,
      sessions,
      config,
    );
    await svc.enrollFace('u1', { photo: 'selfie' });
    expect(redis.counts.has(ENROLL_KEY)).toBe(false);
  });

  it('clearBiometricLockout (central) borra AMBOS bloqueos: turno + enrol', async () => {
    const redis = makeKeyedRedis({ [SHIFT_KEY]: 3, [ENROLL_KEY]: 4 });
    const svc = new DriversService(
      makeEnrollPrismaLocal({ id: 'd1' }) as never,
      redis as never,
      bio,
      sessions,
      config,
    );
    await svc.clearBiometricLockout('d1');
    expect(redis.counts.has(SHIFT_KEY)).toBe(false);
    expect(redis.counts.has(ENROLL_KEY)).toBe(false);
  });

  it('clearBiometricLockout → 404 si el conductor no existe', async () => {
    const svc = new DriversService(
      makeEnrollPrismaLocal(null) as never,
      makeKeyedRedis() as never,
      bio,
      sessions,
      config,
    );
    await expect(svc.clearBiometricLockout('d1')).rejects.toBeInstanceOf(NotFoundError);
  });
});
