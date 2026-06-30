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
import { VehicleClass, VehicleSegment, FleetDocumentType } from '@veo/shared-types';
import { RedisHotIndex } from './redis-hot-index';
import { RedisExclusionRegistry } from './redis-exclusion.registry';
import { RedisTtlExclusionRegistry } from './redis-ttl-exclusion.registry';
import { DriverPool } from '../dispatch/driver-pool';

const A = { lat: -12.0464, lon: -77.0428 };
const B = { lat: -12.09, lon: -77.05 }; // celda distinta
const C = { lat: -12.2, lon: -77.1 }; // celda AISLADA para los tests de eligibilidad B5-3

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

  // ── Exclusión por SUSPENSIÓN con TTL de AUTO-CURA (RedisTtlExclusionRegistry) sobre Redis real ──

  it('exclusión por suspensión: excluye, filtra y limpia (paridad de contrato con el de pánico)', async () => {
    const suspension = new RedisTtlExclusionRegistry(redis, 3_600, 'test:susp:contract');
    await suspension.exclude('s1');
    expect(await suspension.isExcluded('s1')).toBe(true);
    expect(await suspension.filter(['s1', 's2'])).toEqual(['s2']);
    await suspension.clear('s1');
    expect(await suspension.isExcluded('s1')).toBe(false);
  });

  it('AUTO-CURA: si la reactivación nunca llega, la exclusión EXPIRA sola y el conductor re-entra al pool', async () => {
    // TTL de 1s: el modo de falla seguro es re-admitir (over-exclusion acotada), no quedar pegado.
    const suspension = new RedisTtlExclusionRegistry(redis, 1, 'test:susp:ttl');
    await suspension.exclude('stuck');
    expect(await suspension.isExcluded('stuck')).toBe(true); // excluido ahora
    // Esperamos a que Redis expire la key (sin ningún clear() explícito: nadie limpió).
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await suspension.isExcluded('stuck')).toBe(false); // AUTO-CURADO: re-entra al pool
    expect(await suspension.filter(['stuck', 'other'])).toEqual(['stuck', 'other']); // ninguno excluido
  });

  it('re-excluir REFRESCA el TTL (renueva la ventana en cada re-entrega del evento)', async () => {
    const suspension = new RedisTtlExclusionRegistry(redis, 2, 'test:susp:refresh');
    await suspension.exclude('refresh');
    await new Promise((r) => setTimeout(r, 1_000)); // ~mitad de la ventana
    await suspension.exclude('refresh'); // re-suspensión → TTL vuelve a 2s
    await new Promise((r) => setTimeout(r, 1_200)); // pasó el TTL ORIGINAL pero no el refrescado
    expect(await suspension.isExcluded('refresh')).toBe(true); // sigue excluido gracias al refresh
  });

  // ── B5-3 · eligibilidad por oferta sobre Redis REAL (round-trip de attrs + filtro del pool) ──

  it('B5-3 · los attrs de eligibilidad (seats/segment/year) sobreviven el round-trip por Redis real', async () => {
    await hotIndex.upsertLocation('elig-rt', A, VehicleClass.CAR, {
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    const loc = (await hotIndex.candidates([toH3(A, DISPATCH_H3_RESOLUTION)])).find(
      (l) => l.driverId === 'elig-rt',
    );
    expect(loc?.seats).toBe(7);
    expect(loc?.segment).toBe(VehicleSegment.PREMIUM);
    expect(loc?.vehicleYear).toBe(2023);
  });

  it('B5-3 · DriverPool.eligible filtra por el `requires` de la oferta sobre el hot-index vivo', async () => {
    const pool = new DriverPool(hotIndex, exclusion, new RedisTtlExclusionRegistry(redis, 3_600, 'test:suspended:driver'));
    const cellC = toH3(C, DISPATCH_H3_RESOLUTION);
    // Celda C aislada: solo estos 3 (con attrs completos, así el filtro NO degrada a "elegible").
    await hotIndex.upsertLocation('c-mid', C, VehicleClass.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
    });
    await hotIndex.upsertLocation('c-eco', C, VehicleClass.CAR, {
      seats: 5,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    await hotIndex.upsertLocation('c-van', C, VehicleClass.CAR, {
      seats: 7,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });

    // Confort (segment ≥ MID, ≤8 años): solo c-mid (los ECONOMY no califican).
    const confort = await pool.eligible([cellC], VehicleClass.CAR, {
      requires: { minSegment: VehicleSegment.MID, maxAgeYears: 8 },
    });
    expect(confort.map((l) => l.driverId).sort()).toEqual(['c-mid']);

    // XL (6+ asientos): solo c-van (los de 5 no).
    const xl = await pool.eligible([cellC], VehicleClass.CAR, { requires: { minSeats: 6 } });
    expect(xl.map((l) => l.driverId).sort()).toEqual(['c-van']);

    // Sin requires (económico): los 3 (comportamiento previo intacto).
    const all = await pool.eligible([cellC], VehicleClass.CAR);
    expect(all.map((l) => l.driverId).sort()).toEqual(['c-eco', 'c-mid', 'c-van']);
  });

  // ── B5-3.2 · certificaciones del conductor sobre Redis REAL (round-trip + gate fail-closed) ──
  const D = { lat: -12.25, lon: -77.15 }; // celda AISLADA para los tests de certs

  it('B5-3.2 · las certificaciones sobreviven el round-trip por Redis real (LUA MOVE + JSON)', async () => {
    await hotIndex.upsertLocation('cert-rt', A, VehicleClass.CAR, {
      certifications: [FleetDocumentType.AMBULANCE_OPERATOR, FleetDocumentType.TOW_OPERATOR],
    });
    const loc = await hotIndex.getLocation('cert-rt');
    expect(loc?.certifications).toEqual([
      FleetDocumentType.AMBULANCE_OPERATOR,
      FleetDocumentType.TOW_OPERATOR,
    ]);
  });

  it('B5-3.2 · DriverPool gatea las verticales FAIL-CLOSED sobre el hot-index vivo', async () => {
    const pool = new DriverPool(hotIndex, exclusion, new RedisTtlExclusionRegistry(redis, 3_600, 'test:suspended:driver'));
    const cellD = toH3(D, DISPATCH_H3_RESOLUTION);
    // Celda D aislada: uno con la cert de ambulancia, uno con otra cert, uno sin certs.
    await hotIndex.upsertLocation('d-amb', D, VehicleClass.CAR, {
      certifications: [FleetDocumentType.AMBULANCE_OPERATOR],
    });
    await hotIndex.upsertLocation('d-tow', D, VehicleClass.CAR, {
      certifications: [FleetDocumentType.TOW_OPERATOR],
    });
    await hotIndex.upsertLocation('d-none', D, VehicleClass.CAR); // sin certs

    // Ambulancia exige AMBULANCE_OPERATOR: solo d-amb (d-tow y d-none quedan fuera, fail-closed).
    const amb = await pool.eligible([cellD], VehicleClass.CAR, {
      requires: { certifications: [FleetDocumentType.AMBULANCE_OPERATOR] },
    });
    expect(amb.map((l) => l.driverId).sort()).toEqual(['d-amb']);

    // Sin certs requeridas (RIDE): los 3 entran (la cert no restringe lo que no la pide).
    const ride = await pool.eligible([cellD], VehicleClass.CAR);
    expect(ride.map((l) => l.driverId).sort()).toEqual(['d-amb', 'd-none', 'd-tow']);
  });

  // ── ANTI-CLOBBER · un ping sin attrs NO debe borrar los attrs buenos del hot-index ──
  const E = { lat: -12.3, lon: -77.2 }; // celda AISLADA para los tests de clobber

  it('anti-clobber · un ping SIN attrs (fleet 204/outage) PRESERVA los seats/segment/año previos (mismo vehicleType)', async () => {
    // Ping bueno: el conductor opera un XL premium 2023.
    await hotIndex.upsertLocation('clb-keep', E, VehicleClass.CAR, {
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    // Ping degradado: fleet no resolvió (sin attrs), pero la clase sigue siendo la misma.
    await hotIndex.upsertLocation('clb-keep', E, VehicleClass.CAR);
    const loc = await hotIndex.getLocation('clb-keep');
    // Los attrs de tier SOBREVIVEN: el gate de tier no se auto-desarma por un ping sin attrs.
    expect(loc?.seats).toBe(7);
    expect(loc?.segment).toBe(VehicleSegment.PREMIUM);
    expect(loc?.vehicleYear).toBe(2023);
  });

  it('anti-clobber · un ping CON attrs nuevos SÍ pisa los previos (cambio de vehículo real, no se arrastra)', async () => {
    await hotIndex.upsertLocation('clb-overwrite', E, VehicleClass.CAR, {
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    // El conductor cambió a un económico de 5 asientos: el ping trae los attrs nuevos COMPLETOS.
    await hotIndex.upsertLocation('clb-overwrite', E, VehicleClass.CAR, {
      seats: 5,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2020,
    });
    const loc = await hotIndex.getLocation('clb-overwrite');
    expect(loc?.seats).toBe(5);
    expect(loc?.segment).toBe(VehicleSegment.ECONOMY);
    expect(loc?.vehicleYear).toBe(2020);
  });

  it('anti-clobber · un cambio de CLASE NO arrastra los attrs de la clase anterior (vehicleType distinto)', async () => {
    // Operaba un CAR con attrs; cambia a MOTO y el ping de moto no trae attrs de auto.
    await hotIndex.upsertLocation('clb-class', E, VehicleClass.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
    });
    await hotIndex.upsertLocation('clb-class', E, VehicleClass.MOTO);
    const loc = await hotIndex.getLocation('clb-class');
    // Otro vehículo (otra clase): los attrs viejos NO se preservan (serían basura para una moto).
    expect(loc?.vehicleType).toBe(VehicleClass.MOTO);
    expect(loc?.seats).toBeUndefined();
    expect(loc?.segment).toBeUndefined();
    expect(loc?.vehicleYear).toBeUndefined();
  });

  it('anti-clobber · las CERTS NO se preservan: un ping sin certs las quita (gate fail-closed, dirección segura)', async () => {
    await hotIndex.upsertLocation('clb-cert', E, VehicleClass.CAR, {
      certifications: [FleetDocumentType.AMBULANCE_OPERATOR],
    });
    // Ping sin certs: a diferencia de los attrs de tier, las certs NO se arrastran (revocables).
    await hotIndex.upsertLocation('clb-cert', E, VehicleClass.CAR);
    const loc = await hotIndex.getLocation('clb-cert');
    expect(loc?.certifications).toBeUndefined();
  });

  // ── IDENTIDAD DEL CARRY · el carry se llavea por vehicleId sobre Redis REAL (round-trip por el LUA + fix) ──

  it('vehicleId sobrevive el round-trip por Redis real (LUA MOVE + JSON)', async () => {
    await hotIndex.upsertLocation('vid-rt', E, VehicleClass.CAR, {
      vehicleId: 'veh-rt',
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    const loc = await hotIndex.getLocation('vid-rt');
    expect(loc?.vehicleId).toBe('veh-rt');
  });

  it('identidad · swap intra-clase con vehicleId DISTINTO NO arrastra attrs stale (aunque el ping llegue degradado)', async () => {
    // Vehículo A: van XL premium (id "veh-xl").
    await hotIndex.upsertLocation('vid-swap', E, VehicleClass.CAR, {
      vehicleId: 'veh-xl',
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    // Swap a vehículo B (económico, MISMA clase CAR, id "veh-eco") con ping degradado SIN attrs de tier.
    await hotIndex.upsertLocation('vid-swap', E, VehicleClass.CAR, { vehicleId: 'veh-eco' });
    const loc = await hotIndex.getLocation('vid-swap');
    // El id cambió ⇒ no es el mismo vehículo ⇒ los attrs del XL NO se heredan (degradación honesta, no stale).
    expect(loc?.vehicleId).toBe('veh-eco');
    expect(loc?.seats).toBeUndefined();
    expect(loc?.segment).toBeUndefined();
    expect(loc?.vehicleYear).toBeUndefined();
  });

  it('identidad · mismo vehicleId + ping degradado SÍ preserva los attrs (anti-clobber por identidad)', async () => {
    await hotIndex.upsertLocation('vid-keep', E, VehicleClass.CAR, {
      vehicleId: 'veh-xl',
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    // Mismo vehículo (id "veh-xl"), ping sin attrs (fleet 204 transitorio): se preservan los previos.
    await hotIndex.upsertLocation('vid-keep', E, VehicleClass.CAR, { vehicleId: 'veh-xl' });
    const loc = await hotIndex.getLocation('vid-keep');
    expect(loc?.seats).toBe(7);
    expect(loc?.segment).toBe(VehicleSegment.PREMIUM);
    expect(loc?.vehicleYear).toBe(2023);
  });
});
