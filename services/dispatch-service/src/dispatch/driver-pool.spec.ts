/**
 * DriverPool · B5-3 — el filtro de ELIGIBILIDAD por oferta sobre el pool del hot-index.
 * Lo crítico: además del vehicleType, el pool excluye a quien NO satisface el `requires` de la oferta
 * (confort=segment≥MID, xl=6 asientos), y DEGRADA SEGURO: un conductor sin attrs en el ping (legacy) NO
 * se excluye (no romper el matching durante el rollout, hasta que el productor mande los attrs).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VehicleType, VehicleSegment, FleetDocumentType } from '@veo/shared-types';
import { InMemoryHotIndex, InMemoryExclusionRegistry } from '../hot-index/in-memory-hot-index';
import { DriverPool } from './driver-pool';
import type { OperableVehicleClassesProvider } from './operable-vehicle-classes.provider';
import { bumpEligibilityFailOpen } from './dispatch.metrics';

// La observabilidad es un side-effect: espiamos SOLO el bump para asertar que dispara sin tocar el registry
// real. `classifyMissingAttr` se mantiene REAL (importActual) — el pool lo usa para etiquetar qué attr faltó.
vi.mock('./dispatch.metrics', async (importActual) => ({
  ...(await importActual<typeof import('./dispatch.metrics')>()),
  bumpEligibilityFailOpen: vi.fn(),
}));

const CELL = 'cell-1';
const cells = [CELL];

let hotIndex: InMemoryHotIndex;
let suspension: InMemoryExclusionRegistry;
let pool: DriverPool;

beforeEach(() => {
  vi.clearAllMocks();
  hotIndex = new InMemoryHotIndex();
  suspension = new InMemoryExclusionRegistry();
  pool = new DriverPool(hotIndex, new InMemoryExclusionRegistry(), suspension);
});

const ids = (locs: { driverId: string }[]) => locs.map((l) => l.driverId).sort();

describe('DriverPool.eligible · B5-3 eligibilidad por oferta', () => {
  it('sin requires → todos los del tipo (comportamiento previo intacto)', async () => {
    await hotIndex.seed('a', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2020,
    });
    await hotIndex.seed('b', -12, -77, CELL, VehicleType.CAR, {
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    expect(ids(await pool.eligible(cells, VehicleType.CAR))).toEqual(['a', 'b']);
  });

  it('xl (minSeats 6): excluye un sedán de 5, incluye una van de 7', async () => {
    await hotIndex.seed('sedan', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
    });
    await hotIndex.seed('van', -12, -77, CELL, VehicleType.CAR, {
      seats: 7,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    const out = await pool.eligible(cells, VehicleType.CAR, { requires: { minSeats: 6 } });
    expect(ids(out)).toEqual(['van']);
  });

  it('confort (minSegment MID): excluye ECONOMY, incluye MID/PREMIUM', async () => {
    await hotIndex.seed('eco', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    await hotIndex.seed('mid', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
    });
    await hotIndex.seed('prem', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2022,
    });
    const out = await pool.eligible(cells, VehicleType.CAR, {
      requires: { minSegment: VehicleSegment.MID },
    });
    expect(ids(out)).toEqual(['mid', 'prem']);
  });

  it('confort (maxAgeYears 8): excluye un MID viejo (2000), incluye uno reciente', async () => {
    await hotIndex.seed('old', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2000,
    });
    await hotIndex.seed('new', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2024,
    });
    const out = await pool.eligible(cells, VehicleType.CAR, {
      requires: { minSegment: VehicleSegment.MID, maxAgeYears: 8 },
    });
    expect(ids(out)).toEqual(['new']);
  });

  it('DEGRADACIÓN: un ping SIN attrs (legacy) NO se excluye aunque haya requires', async () => {
    await hotIndex.seed('legacy', -12, -77, CELL, VehicleType.CAR); // sin attrs
    await hotIndex.seed('ineligible', -12, -77, CELL, VehicleType.CAR, {
      seats: 4,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    const out = await pool.eligible(cells, VehicleType.CAR, { requires: { minSeats: 6 } });
    // legacy pasa (degradación); el que SÍ trae attrs y no cumple, se excluye.
    expect(ids(out)).toEqual(['legacy']);
  });

  it('OBSERVABILIDAD (source=pool): el fail-open BUMPEA la métrica sin cambiar el resultado (legacy igual pasa)', async () => {
    await hotIndex.seed('legacy', -12, -77, CELL, VehicleType.CAR); // sin attrs → faltan los 3 → 'multiple'
    const out = await pool.eligible(cells, VehicleType.CAR, { requires: { minSeats: 6 } });
    expect(ids(out)).toEqual(['legacy']); // comportamiento INTACTO (cero cambio)
    // El pool es el barrido amplio de candidatos → source='pool' (prevalencia de flota).
    expect(bumpEligibilityFailOpen).toHaveBeenCalledWith('pool', 'multiple');
  });

  it('OBSERVABILIDAD (C1): NO bumpea cuando los attrs SÍ están (no hay fail-open)', async () => {
    await hotIndex.seed('full', -12, -77, CELL, VehicleType.CAR, {
      seats: 7,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2023,
    });
    await pool.eligible(cells, VehicleType.CAR, { requires: { minSeats: 6 } });
    expect(bumpEligibilityFailOpen).not.toHaveBeenCalled();
  });

  it('respeta el vehicleType además del requires (una MOTO no entra a un pool CAR)', async () => {
    await hotIndex.seed('moto', -12, -77, CELL, VehicleType.MOTO, {
      seats: 2,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    await hotIndex.seed('car', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
    });
    expect(
      ids(
        await pool.eligible(cells, VehicleType.CAR, {
          requires: { minSegment: VehicleSegment.MID },
        }),
      ),
    ).toEqual(['car']);
  });
});

describe('DriverPool.eligible · B5-3.2 certificaciones (FAIL-CLOSED, opuesto a los attrs)', () => {
  const ambulance = { certifications: [FleetDocumentType.AMBULANCE_OPERATOR] };

  it('conductor SIN certs → EXCLUIDO de la vertical que las exige (fail-closed)', async () => {
    await hotIndex.seed('nocert', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
    });
    expect(ids(await pool.eligible(cells, VehicleType.CAR, { requires: ambulance }))).toEqual([]);
  });

  it('conductor con la cert VÁLIDA → incluido', async () => {
    await hotIndex.seed('amb', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
      certifications: [FleetDocumentType.AMBULANCE_OPERATOR],
    });
    expect(ids(await pool.eligible(cells, VehicleType.CAR, { requires: ambulance }))).toEqual([
      'amb',
    ]);
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
    await hotIndex.seed('a', -12, -77, CELL, VehicleType.CAR, {
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
    });
    expect(
      ids(
        await pool.eligible(cells, VehicleType.CAR, {
          requires: { minSegment: VehicleSegment.MID },
        }),
      ),
    ).toEqual(['a']);
  });
});

describe('DriverPool.eligible · FILTRO DEFENSIVO de clase operable (seam catálogo↔operabilidad · ADR 013)', () => {
  /** Doble del provider: devuelve el set de clases operables que se le configure (sin REST ni cache). */
  const provider = (operable: VehicleType[]): OperableVehicleClassesProvider =>
    ({ get: vi.fn(async () => operable) }) as unknown as OperableVehicleClassesProvider;

  it('la clase NO operable (MOTO apagada en el catálogo) queda EXCLUIDA del pool aunque el conductor pinguee', async () => {
    await hotIndex.seed('moto', -12, -77, CELL, VehicleType.MOTO);
    // Catálogo efectivo: solo CAR operable → una MOTO no debe recibir ofertas.
    const p = new DriverPool(hotIndex, new InMemoryExclusionRegistry(), suspension, provider([VehicleType.CAR]));
    expect(ids(await p.eligible(cells, VehicleType.MOTO))).toEqual([]);
  });

  it('la clase operable (CAR) sigue entrando; la MOTO entra solo cuando el catálogo la habilita', async () => {
    await hotIndex.seed('car', -12, -77, CELL, VehicleType.CAR);
    await hotIndex.seed('moto', -12, -77, CELL, VehicleType.MOTO);
    // Ambas clases operables → cada pool devuelve su clase.
    const p = new DriverPool(
      hotIndex,
      new InMemoryExclusionRegistry(),
      suspension,
      provider([VehicleType.CAR, VehicleType.MOTO]),
    );
    expect(ids(await p.eligible(cells, VehicleType.CAR))).toEqual(['car']);
    expect(ids(await p.eligible(cells, VehicleType.MOTO))).toEqual(['moto']);
  });

  it('SIN provider inyectado (@Optional) → NO filtra: comportamiento histórico intacto', async () => {
    await hotIndex.seed('moto', -12, -77, CELL, VehicleType.MOTO);
    // `pool` del beforeEach se construye SIN provider → el filtro se salta (la MOTO pasa).
    expect(ids(await pool.eligible(cells, VehicleType.MOTO))).toEqual(['moto']);
  });
});

describe('DriverPool.eligible · exclusión por SUSPENSIÓN del conductor', () => {
  it('un conductor SUSPENDIDO (en el set de suspensión) NO es elegible aunque siga pingeando GPS', async () => {
    await hotIndex.seed('activo', -12, -77, CELL, VehicleType.CAR);
    await hotIndex.seed('suspendido', -12, -77, CELL, VehicleType.CAR);
    // El suspendido sigue VIVO en el hot-index (su app pinguea), pero está excluido del pool.
    await suspension.exclude('suspendido');
    expect(ids(await pool.eligible(cells, VehicleType.CAR))).toEqual(['activo']);
  });

  it('al reincorporarse (clear), el conductor vuelve a ser elegible', async () => {
    await hotIndex.seed('d', -12, -77, CELL, VehicleType.CAR);
    await suspension.exclude('d');
    expect(ids(await pool.eligible(cells, VehicleType.CAR))).toEqual([]);
    await suspension.clear('d');
    expect(ids(await pool.eligible(cells, VehicleType.CAR))).toEqual(['d']);
  });
});
