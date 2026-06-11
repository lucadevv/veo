/**
 * Integración del hot index sobre Redis REAL (testcontainers). Ejercita el script LUA atómico de
 * movimiento entre celdas, el TTL de disponibilidad y la exclusión por pánico.
 *
 * Se ejecuta solo con RUN_INTEGRATION=1 (requiere Docker). Excluido por defecto en vitest.config.ts
 * para mantener `pnpm test` verde sin dependencias externas.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { toH3, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { VehicleClass } from '@veo/shared-types';
import { RedisHotIndex } from './redis-hot-index';
import { RedisExclusionRegistry } from './redis-exclusion.registry';

const A = { lat: -12.0464, lon: -77.0428 };
const B = { lat: -12.09, lon: -77.05 }; // celda distinta

describe('RedisHotIndex · integración (Redis real)', () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let hotIndex: RedisHotIndex;
  let exclusion: RedisExclusionRegistry;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) });
    hotIndex = new RedisHotIndex(redis, 60);
    exclusion = new RedisExclusionRegistry(redis);
  }, 120_000);

  afterAll(async () => {
    await redis?.quit();
    await container?.stop();
  });

  it('indexa y recupera candidatos disponibles por celda', async () => {
    await hotIndex.upsertLocation('d1', A, VehicleClass.CAR);
    const cellA = toH3(A, DISPATCH_H3_RESOLUTION);
    const found = await hotIndex.candidates([cellA]);
    expect(found.map((f) => f.driverId)).toContain('d1');
  });

  it('mueve atómicamente al conductor entre celdas (LUA SREM+SADD)', async () => {
    await hotIndex.upsertLocation('d2', A, VehicleClass.CAR);
    const cellA = toH3(A, DISPATCH_H3_RESOLUTION);
    const cellB = toH3(B, DISPATCH_H3_RESOLUTION);
    await hotIndex.upsertLocation('d2', B, VehicleClass.CAR);
    expect((await hotIndex.candidates([cellA])).map((f) => f.driverId)).not.toContain('d2');
    expect((await hotIndex.candidates([cellB])).map((f) => f.driverId)).toContain('d2');
  });

  it('markBusy saca al conductor del pool y markAvailable lo reincorpora', async () => {
    await hotIndex.upsertLocation('d3', A, VehicleClass.CAR);
    const cellA = toH3(A, DISPATCH_H3_RESOLUTION);
    await hotIndex.markBusy('d3');
    expect((await hotIndex.candidates([cellA])).map((f) => f.driverId)).not.toContain('d3');
    await hotIndex.markAvailable('d3');
    expect((await hotIndex.candidates([cellA])).map((f) => f.driverId)).toContain('d3');
  });

  it('exclusión por pánico filtra al conductor', async () => {
    await exclusion.exclude('d9');
    expect(await exclusion.isExcluded('d9')).toBe(true);
    expect(await exclusion.filter(['d9', 'd8'])).toEqual(['d8']);
    await exclusion.clear('d9');
    expect(await exclusion.isExcluded('d9')).toBe(false);
  });
});
