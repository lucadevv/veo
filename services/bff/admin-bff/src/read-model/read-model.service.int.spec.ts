/**
 * ReadModelService.upsertDriver · CAS ATÓMICO (Lua) sobre Redis REAL.
 *
 * El fence de monotonía POR-ASPECTO ahora corre como un script Lua atómico (UPSERT_DRIVER_CAS) para
 * cerrar el TOCTOU del compare-in-JS previo bajo multi-réplica (admin-bff replicas:2, HPA→10; eventos
 * cross-topic del mismo driver caen en pods distintos del mismo consumer group → dos upsertDriver
 * concurrentes sobre el mismo hash, lost-update). El fake in-memory de ioredis NO puede interpretar
 * Lua → estos tests EXIGEN Redis real.
 *
 * Se ejecutan solo con RUN_INTEGRATION=1 (requiere Docker / testcontainers). Excluidos por defecto en
 * vitest.config.ts para mantener `pnpm test` verde sin dependencias externas (patrón de dispatch-service).
 * Correr: `pnpm --filter @veo/admin-bff test:int`.
 *
 * Cobertura: (a) stale no pisa status · (b) reorden cross-topic ambas direcciones · (c) primer evento
 * aplica + siembra watermark · (d) rating (touchesStatus=0) NO bloqueado y NO siembra índice de status ·
 * (e) redelivery exacta idempotente · (f) CAS sin lost-update · (g) stale NO regresa updatedAt/score ·
 * (h) rating-primero NO siembra 'UNKNOWN' en índices de status.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { ReadModelService } from './read-model.service';

const DRIVERS = 'bff:rm:drivers';
const hashKey = (id: string) => `bff:rm:driver:${id}`;
const statusIndex = (status: string) => `${DRIVERS}:s:${status}`;

// Timestamps fijos para reordenar a voluntad. T1 < T2 < T3.
const T1 = '2026-06-19T10:00:00.000Z';
const T2 = '2026-06-19T11:00:00.000Z';
const T3 = '2026-06-19T12:00:00.000Z';
// El watermark statusUpdatedAt se persiste como epoch ms numérico (string en el hash de Redis).
const wm = (iso: string) => String(Date.parse(iso));

describe('ReadModelService.upsertDriver · CAS atómico (Redis real)', () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let svc: ReadModelService;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) });
    svc = new ReadModelService(redis);
  }, 120_000);

  afterAll(async () => {
    await redis?.quit();
    await container?.stop();
  });

  // Cada test aísla su keyspace para no contaminarse (no flushall: solo el namespace del read-model).
  beforeEach(async () => {
    await redis.flushdb();
  });

  const field = (id: string, f: string) => redis.hget(hashKey(id), f);
  const members = (status: string) => redis.zrange(statusIndex(status), 0, -1);
  const globalScore = (id: string) => redis.zscore(DRIVERS, id);

  it('(a) evento stale NO pisa: suspended(T2) luego verified(T1<T2) → sigue SUSPENDED', async () => {
    await svc.upsertDriver({ id: 'd1', status: 'SUSPENDED', updatedAt: T2 });
    await svc.upsertDriver({
      id: 'd1',
      status: 'ACTIVE',
      backgroundCheckStatus: 'VERIFIED',
      updatedAt: T1,
    });

    expect(await field('d1', 'status')).toBe('SUSPENDED');
    expect(await members('SUSPENDED')).toContain('d1');
    expect(await members('ACTIVE')).not.toContain('d1');
    // El watermark quedó anclado en T2 (no retrocede con el evento viejo).
    expect(await field('d1', 'statusUpdatedAt')).toBe(wm(T2));
  });

  it('(b) reorden cross-topic: suspended(T2) luego driver.reactivated(T1<T2) → NO resucita ACTIVE', async () => {
    await svc.upsertDriver({ id: 'd2', status: 'SUSPENDED', updatedAt: T2 });
    await svc.upsertDriver({ id: 'd2', status: 'ACTIVE', updatedAt: T1 });

    expect(await field('d2', 'status')).toBe('SUSPENDED');
    expect(await members('SUSPENDED')).toContain('d2');
    expect(await members('ACTIVE')).not.toContain('d2');
  });

  it('(b-inverso) reactivated(T2) luego fleet.driver_suspended(T1<T2) → NO suspende, sigue ACTIVE', async () => {
    await svc.upsertDriver({ id: 'd3', status: 'ACTIVE', updatedAt: T2 });
    await svc.upsertDriver({ id: 'd3', status: 'SUSPENDED', updatedAt: T1 });

    expect(await field('d3', 'status')).toBe('ACTIVE');
    expect(await members('ACTIVE')).toContain('d3');
    expect(await members('SUSPENDED')).not.toContain('d3');
  });

  it('(c) primer evento (sin current) aplica + siembra el watermark', async () => {
    await svc.upsertDriver({
      id: 'd4',
      status: 'ACTIVE',
      backgroundCheckStatus: 'VERIFIED',
      updatedAt: T1,
    });

    expect(await field('d4', 'status')).toBe('ACTIVE');
    expect(await field('d4', 'backgroundCheckStatus')).toBe('VERIFIED');
    expect(await field('d4', 'statusUpdatedAt')).toBe(wm(T1));
    expect(await members('ACTIVE')).toContain('d4');
  });

  it('(d) eje disjunto NO bloqueado: suspended(T2) luego flagged(averageRating) → rating aplica, status intacto', async () => {
    await svc.upsertDriver({ id: 'd5', status: 'SUSPENDED', updatedAt: T2 });
    // driver.flagged: trae SOLO averageRating, con su propio updatedAt (incluso anterior a T2).
    await svc.upsertDriver({ id: 'd5', averageRating: 4.5, updatedAt: T1 });

    expect(await field('d5', 'averageRating')).toBe('4.5');
    expect(await field('d5', 'status')).toBe('SUSPENDED');
    // El watermark del status quedó intacto (el evento de rating no lo toca).
    expect(await field('d5', 'statusUpdatedAt')).toBe(wm(T2));
    expect(await members('SUSPENDED')).toContain('d5');
  });

  it('(e) redelivery exacta: mismo verified(T2) dos veces → idempotente, sin doble movimiento de índice', async () => {
    await svc.upsertDriver({ id: 'd6', status: 'PENDING', updatedAt: T1 });
    await svc.upsertDriver({
      id: 'd6',
      status: 'ACTIVE',
      backgroundCheckStatus: 'VERIFIED',
      updatedAt: T2,
    });
    // Misma entrega exacta otra vez (ts idéntico → <= descarta).
    await svc.upsertDriver({
      id: 'd6',
      status: 'ACTIVE',
      backgroundCheckStatus: 'VERIFIED',
      updatedAt: T2,
    });

    expect(await field('d6', 'status')).toBe('ACTIVE');
    expect(await field('d6', 'statusUpdatedAt')).toBe(wm(T2));
    expect(await members('ACTIVE')).toEqual(['d6']);
    expect(await members('PENDING')).not.toContain('d6');
  });

  // ── NUEVOS: cierran el CRÍTICO TOCTOU y los MEDIA de recencia/phantom ──

  it('(f) CAS sin lost-update: dos writers con el watermark viejo → gana el ts mayor (el menor se descarta)', async () => {
    // Sembramos un primer estado en T1 para que AMBOS writers vean el mismo watermark previo.
    await svc.upsertDriver({ id: 'd7', status: 'PENDING', updatedAt: T1 });

    // Dos eventos cross-topic concurrentes del mismo driver (lo que en multi-réplica corre en pods
    // distintos). Con el compare-in-JS habría lost-update; el CAS atómico serializa y conserva el mayor.
    await Promise.all([
      svc.upsertDriver({ id: 'd7', status: 'SUSPENDED', updatedAt: T3 }), // ts mayor
      svc.upsertDriver({ id: 'd7', status: 'ACTIVE', updatedAt: T2 }), // ts menor
    ]);

    // Sea cual sea el orden de llegada, el estado final es el del ts mayor (T3 → SUSPENDED) y el
    // watermark quedó en T3. El menor (ACTIVE@T2) fue descartado por el fence dentro del CAS.
    expect(await field('d7', 'status')).toBe('SUSPENDED');
    expect(await field('d7', 'statusUpdatedAt')).toBe(wm(T3));
    expect(await members('SUSPENDED')).toEqual(['d7']);
    expect(await members('ACTIVE')).not.toContain('d7');
  });

  it('(g) stale NO regresa updatedAt/score (recencia): suspended(T2) luego verified(T1) deja updatedAt=T2', async () => {
    await svc.upsertDriver({ id: 'd8', status: 'SUSPENDED', updatedAt: T2 });
    const scoreAfterT2 = await globalScore('d8');
    await svc.upsertDriver({
      id: 'd8',
      status: 'ACTIVE',
      backgroundCheckStatus: 'VERIFIED',
      updatedAt: T1,
    });

    // El evento stale no debe regresar la recencia: updatedAt y el score global quedan en T2.
    expect(await field('d8', 'updatedAt')).toBe(T2);
    expect(await globalScore('d8')).toBe(scoreAfterT2);
    expect(Number(scoreAfterT2)).toBe(Date.parse(T2));
  });

  it('(h) rating-primero NO siembra UNKNOWN en índices de status (touchesStatus=0)', async () => {
    // Primer evento del driver es un rating puro: NO debe crear el índice de status UNKNOWN.
    await svc.upsertDriver({ id: 'd9', averageRating: 4.8, updatedAt: T1 });

    expect(await field('d9', 'averageRating')).toBe('4.8');
    // El campo status NO se escribió (toDriver lo leerá como 'UNKNOWN' por default, pero el índice está limpio).
    expect(await redis.exists(statusIndex('UNKNOWN'))).toBe(0);
    expect(await members('UNKNOWN')).toEqual([]);
    // Sí entró al índice global de recencia (es actividad legítima).
    expect(await globalScore('d9')).toBe(String(Date.parse(T1)));

    // Y cuando luego llega un status real, ahí sí entra al índice correcto (sin rastro de UNKNOWN).
    await svc.upsertDriver({ id: 'd9', status: 'ACTIVE', updatedAt: T2 });
    expect(await members('ACTIVE')).toEqual(['d9']);
    expect(await members('UNKNOWN')).toEqual([]);
  });

  it('(i) re-aprobación limpia rejectionReason (null explícito) y conserva rating ausente', async () => {
    await svc.upsertDriver({
      id: 'd10',
      status: 'REJECTED',
      backgroundCheckStatus: 'REJECTED',
      rejectionReason: 'docs vencidos',
      averageRating: 4.2,
      updatedAt: T1,
    });
    expect(await field('d10', 'rejectionReason')).toBe('docs vencidos');

    // Re-aprobación: status nuevo + rejectionReason explícito null (limpiar). Rating ausente se conserva.
    await svc.upsertDriver({
      id: 'd10',
      status: 'ACTIVE',
      backgroundCheckStatus: 'VERIFIED',
      rejectionReason: null,
      updatedAt: T2,
    });
    expect(await field('d10', 'rejectionReason')).toBe('');
    expect(await field('d10', 'status')).toBe('ACTIVE');
    expect(await field('d10', 'averageRating')).toBe('4.2');
  });

  it('(j) los conductores PERSISTEN (sin TTL) y un TTL legacy se REMUEVE en el próximo upsert', async () => {
    // Un upsert de conductor deja el hash SIN expiración (ttl=-1): la flota es una entidad admin durable,
    // no se vence como los viajes. Antes el hash llevaba EXPIRE 14d → los conductores ya decididos
    // DESAPARECÍAN de "Todos"; ese era el corazón de la deuda del read-model de flota.
    await svc.upsertDriver({ id: 'd11', status: 'PENDING', backgroundCheckStatus: 'PENDING', updatedAt: T1 });
    expect(await redis.ttl(hashKey('d11'))).toBe(-1);

    // Defensa de migración: una fila con TTL legacy (política vieja) se PERSISTE en el siguiente upsert.
    await redis.expire(hashKey('d11'), 1000);
    expect(await redis.ttl(hashKey('d11'))).toBeGreaterThan(0);
    await svc.upsertDriver({ id: 'd11', status: 'ACTIVE', backgroundCheckStatus: 'VERIFIED', updatedAt: T2 });
    expect(await redis.ttl(hashKey('d11'))).toBe(-1);
  });
});
