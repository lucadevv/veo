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

  // RESIDUAL CONOCIDO (gate adversarial wkrozhaf6, ALTA refutada a "inerte hoy / landmine del flip"): el
  // carry se llavea por vehicleType, que NO distingue un swap DENTRO de la misma clase. Este test DOCUMENTA
  // el comportamiento actual (no es el deseado bajo fail-closed): hoy es inocuo (gate fail-open + el resolver
  // pisa el carry en ≤20s). PREREQUISITO DEL FLIP: keyear por vehicleId. Si alguien cierra ese hueco, este
  // test debe cambiar (el económico NO debería heredar seats=7 del XL).
  it('[residual documentado] swap intra-clase SIN attrs arrastra attrs stale (a corregir antes del flip)', async () => {
    const idx = new InMemoryHotIndex();
    // Vehículo A: van XL premium.
    await idx.upsertLocation('d', P, VehicleClass.CAR, {
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    // Swap a vehículo B (económico, misma clase CAR) cuyo ping llega degradado SIN attrs (fleet 204/outage).
    await idx.upsertLocation('d', P, VehicleClass.CAR);
    const loc = await idx.getLocation('d');
    // Comportamiento ACTUAL: hereda los attrs del XL (el guard por clase no detecta el swap).
    expect(loc?.seats).toBe(7);
    expect(loc?.segment).toBe(VehicleSegment.PREMIUM);
  });
});
