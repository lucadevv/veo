/**
 * Paridad de contrato del doble en memoria con RedisHotIndex: el anti-clobber de attrs de tier (B5-3).
 * El gate adversarial cazó que el fake clobbeaba mientras Redis preservaba → el doble mentía sobre el
 * "mismo contrato" y los tests unitarios de pool/gate (que usan el fake) ejercían el comportamiento VIEJO.
 * Estos casos cubren la preservación a nivel UNITARIO (el int.spec ya la cubre sobre Redis real).
 */
import { describe, it, expect } from 'vitest';
import { VehicleClass, VehicleSegment, FleetDocumentType } from '@veo/shared-types';
import { InMemoryHotIndex } from './in-memory-hot-index';

const P = { lat: -12.05, lon: -77.04 };

describe('InMemoryHotIndex · paridad anti-clobber con Redis', () => {
  it('un ping SIN attrs PRESERVA los seats/segment/año previos (mismo vehicleType)', async () => {
    const idx = new InMemoryHotIndex();
    await idx.upsertLocation('d', P, VehicleClass.CAR, {
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    await idx.upsertLocation('d', P, VehicleClass.CAR); // ping degradado sin attrs
    const loc = await idx.getLocation('d');
    expect(loc?.seats).toBe(7);
    expect(loc?.segment).toBe(VehicleSegment.PREMIUM);
    expect(loc?.vehicleYear).toBe(2023);
  });

  it('un ping CON attrs nuevos PISA los previos (cambio de vehículo real con datos)', async () => {
    const idx = new InMemoryHotIndex();
    await idx.upsertLocation('d', P, VehicleClass.CAR, {
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    await idx.upsertLocation('d', P, VehicleClass.CAR, {
      seats: 5,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2020,
    });
    const loc = await idx.getLocation('d');
    expect(loc?.seats).toBe(5);
    expect(loc?.segment).toBe(VehicleSegment.ECONOMY);
    expect(loc?.vehicleYear).toBe(2020);
  });

  it('un cambio de CLASE NO arrastra los attrs de la clase anterior', async () => {
    const idx = new InMemoryHotIndex();
    await idx.upsertLocation('d', P, VehicleClass.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
    });
    await idx.upsertLocation('d', P, VehicleClass.MOTO);
    const loc = await idx.getLocation('d');
    expect(loc?.vehicleType).toBe(VehicleClass.MOTO);
    expect(loc?.seats).toBeUndefined();
    expect(loc?.segment).toBeUndefined();
    expect(loc?.vehicleYear).toBeUndefined();
  });

  it('las CERTS NO se preservan: un ping sin certs las quita (fail-closed, dirección segura)', async () => {
    const idx = new InMemoryHotIndex();
    await idx.upsertLocation('d', P, VehicleClass.CAR, {
      certifications: [FleetDocumentType.AMBULANCE_OPERATOR],
    });
    await idx.upsertLocation('d', P, VehicleClass.CAR);
    const loc = await idx.getLocation('d');
    expect(loc?.certifications).toBeUndefined();
  });

  // IDENTIDAD DEL CARRY (cierra el prerequisito del flip · gate wkrozhaf6): el carry se llavea por vehicleId.
  // Tres casos cubren la nueva semántica: el FIX (swap intra-clase con id distinto no arrastra), la IDENTIDAD
  // que preserva (mismo id + ping degradado sí preserva), y el FALLBACK de compat (ping sin id → guard por clase).

  it('[fix] swap intra-clase CON vehicleId distinto NO arrastra attrs stale (aunque el ping llegue degradado)', async () => {
    const idx = new InMemoryHotIndex();
    // Vehículo A: van XL premium (id "veh-xl").
    await idx.upsertLocation('d', P, VehicleClass.CAR, {
      vehicleId: 'veh-xl',
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    // Swap a vehículo B (económico, misma clase CAR, id "veh-eco") cuyo ping llega degradado SIN attrs de tier
    // pero SÍ con su identidad (el bff la sella server-authoritative aunque fleet no devuelva la ficha completa).
    await idx.upsertLocation('d', P, VehicleClass.CAR, { vehicleId: 'veh-eco' });
    const loc = await idx.getLocation('d');
    // El id cambió ⇒ NO es el mismo vehículo ⇒ no hay carry: los attrs del XL NO se heredan (degradación honesta).
    expect(loc?.vehicleId).toBe('veh-eco');
    expect(loc?.seats).toBeUndefined();
    expect(loc?.segment).toBeUndefined();
    expect(loc?.vehicleYear).toBeUndefined();
  });

  it('[identidad] mismo vehicleId + ping degradado SÍ preserva los attrs (el anti-clobber sigue, ahora por id)', async () => {
    const idx = new InMemoryHotIndex();
    await idx.upsertLocation('d', P, VehicleClass.CAR, {
      vehicleId: 'veh-xl',
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    // Mismo vehículo (id "veh-xl"), ping sin attrs (fleet 204 transitorio): se preservan los del ping previo.
    await idx.upsertLocation('d', P, VehicleClass.CAR, { vehicleId: 'veh-xl' });
    const loc = await idx.getLocation('d');
    expect(loc?.seats).toBe(7);
    expect(loc?.segment).toBe(VehicleSegment.PREMIUM);
    expect(loc?.vehicleYear).toBe(2023);
  });

  it('[compat] ping legacy SIN vehicleId cae al guard por vehicleType (comportamiento previo, inocuo fail-open)', async () => {
    const idx = new InMemoryHotIndex();
    // Sin vehicleId en ningún ping (app vieja / fleet 204 sin vehículo activo): el carry usa el fallback por clase.
    await idx.upsertLocation('d', P, VehicleClass.CAR, {
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    await idx.upsertLocation('d', P, VehicleClass.CAR);
    const loc = await idx.getLocation('d');
    // Misma clase, sin identidad para distinguir ⇒ preserva (igual que antes del flip · self-heal al próximo ping).
    expect(loc?.seats).toBe(7);
    expect(loc?.segment).toBe(VehicleSegment.PREMIUM);
  });
});
