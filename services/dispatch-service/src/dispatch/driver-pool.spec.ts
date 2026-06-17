/**
 * DriverPool · B5-3 — el filtro de ELIGIBILIDAD por oferta sobre el pool del hot-index.
 * Lo crítico: además del vehicleType, el pool excluye a quien NO satisface el `requires` de la oferta
 * (confort=segment≥MID, xl=6 asientos), y DEGRADA SEGURO: un conductor sin attrs en el ping (legacy) NO
 * se excluye (no romper el matching durante el rollout, hasta que el productor mande los attrs).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VehicleType, VehicleSegment, FleetDocumentType } from '@veo/shared-types';
import { InMemoryHotIndex, InMemoryExclusionRegistry } from '../hot-index/in-memory-hot-index';
import { DriverPool } from './driver-pool';

const CELL = 'cell-1';
const cells = [CELL];

let hotIndex: InMemoryHotIndex;
let pool: DriverPool;

beforeEach(() => {
  hotIndex = new InMemoryHotIndex();
  pool = new DriverPool(hotIndex, new InMemoryExclusionRegistry());
});

const ids = (locs: { driverId: string }[]) => locs.map((l) => l.driverId).sort();

describe('DriverPool.eligible · B5-3 eligibilidad por oferta', () => {
  it('sin requires → todos los del tipo (comportamiento previo intacto)', async () => {
    await hotIndex.seed('a', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.ECONOMY, vehicleYear: 2020 });
    await hotIndex.seed('b', -12, -77, CELL, VehicleType.CAR, { seats: 7, segment: VehicleSegment.PREMIUM, vehicleYear: 2023 });
    expect(ids(await pool.eligible(cells, VehicleType.CAR))).toEqual(['a', 'b']);
  });

  it('xl (minSeats 6): excluye un sedán de 5, incluye una van de 7', async () => {
    await hotIndex.seed('sedan', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.MID, vehicleYear: 2022 });
    await hotIndex.seed('van', -12, -77, CELL, VehicleType.CAR, { seats: 7, segment: VehicleSegment.ECONOMY, vehicleYear: 2022 });
    const out = await pool.eligible(cells, VehicleType.CAR, { requires: { minSeats: 6 } });
    expect(ids(out)).toEqual(['van']);
  });

  it('confort (minSegment MID): excluye ECONOMY, incluye MID/PREMIUM', async () => {
    await hotIndex.seed('eco', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.ECONOMY, vehicleYear: 2022 });
    await hotIndex.seed('mid', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.MID, vehicleYear: 2022 });
    await hotIndex.seed('prem', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.PREMIUM, vehicleYear: 2022 });
    const out = await pool.eligible(cells, VehicleType.CAR, { requires: { minSegment: VehicleSegment.MID } });
    expect(ids(out)).toEqual(['mid', 'prem']);
  });

  it('confort (maxAgeYears 8): excluye un MID viejo (2000), incluye uno reciente', async () => {
    await hotIndex.seed('old', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.MID, vehicleYear: 2000 });
    await hotIndex.seed('new', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.MID, vehicleYear: 2024 });
    const out = await pool.eligible(cells, VehicleType.CAR, { requires: { minSegment: VehicleSegment.MID, maxAgeYears: 8 } });
    expect(ids(out)).toEqual(['new']);
  });

  it('DEGRADACIÓN: un ping SIN attrs (legacy) NO se excluye aunque haya requires', async () => {
    await hotIndex.seed('legacy', -12, -77, CELL, VehicleType.CAR); // sin attrs
    await hotIndex.seed('ineligible', -12, -77, CELL, VehicleType.CAR, { seats: 4, segment: VehicleSegment.ECONOMY, vehicleYear: 2022 });
    const out = await pool.eligible(cells, VehicleType.CAR, { requires: { minSeats: 6 } });
    // legacy pasa (degradación); el que SÍ trae attrs y no cumple, se excluye.
    expect(ids(out)).toEqual(['legacy']);
  });

  it('respeta el vehicleType además del requires (una MOTO no entra a un pool CAR)', async () => {
    await hotIndex.seed('moto', -12, -77, CELL, VehicleType.MOTO, { seats: 2, segment: VehicleSegment.ECONOMY, vehicleYear: 2022 });
    await hotIndex.seed('car', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.MID, vehicleYear: 2022 });
    expect(ids(await pool.eligible(cells, VehicleType.CAR, { requires: { minSegment: VehicleSegment.MID } }))).toEqual(['car']);
  });
});

describe('DriverPool.eligible · B5-3.2 certificaciones (FAIL-CLOSED, opuesto a los attrs)', () => {
  const ambulance = { certifications: [FleetDocumentType.AMBULANCE_OPERATOR] };

  it('conductor SIN certs → EXCLUIDO de la vertical que las exige (fail-closed)', async () => {
    await hotIndex.seed('nocert', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.MID, vehicleYear: 2022 });
    expect(ids(await pool.eligible(cells, VehicleType.CAR, { requires: ambulance }))).toEqual([]);
  });

  it('conductor con la cert VÁLIDA → incluido', async () => {
    await hotIndex.seed('amb', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
      certifications: [FleetDocumentType.AMBULANCE_OPERATOR],
    });
    expect(ids(await pool.eligible(cells, VehicleType.CAR, { requires: ambulance }))).toEqual(['amb']);
  });

  it('conductor con OTRA cert (grúa) → EXCLUIDO de la ambulancia (no se cruzan credenciales)', async () => {
    await hotIndex.seed('tow', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
      certifications: [FleetDocumentType.TOW_OPERATOR],
    });
    expect(ids(await pool.eligible(cells, VehicleType.CAR, { requires: ambulance }))).toEqual([]);
  });

  it('CONTRASTE con attrs: un ping SIN certs es fail-CLOSED (excluido), aunque el legacy sin attrs sea fail-OPEN', async () => {
    // 'legacy' no trae NI attrs NI certs: para un requires de solo-attrs pasaría (fail-open), pero para
    // una vertical que exige cert queda EXCLUIDO (fail-closed). La cert manda.
    await hotIndex.seed('legacy', -12, -77, CELL, VehicleType.CAR);
    expect(ids(await pool.eligible(cells, VehicleType.CAR, { requires: ambulance }))).toEqual([]);
  });

  it('la cert NO afecta a las ofertas RIDE (sin certs requeridas): siguen entrando todos', async () => {
    await hotIndex.seed('a', -12, -77, CELL, VehicleType.CAR, { seats: 5, segment: VehicleSegment.MID, vehicleYear: 2022 });
    expect(ids(await pool.eligible(cells, VehicleType.CAR, { requires: { minSegment: VehicleSegment.MID } }))).toEqual(['a']);
  });
});
