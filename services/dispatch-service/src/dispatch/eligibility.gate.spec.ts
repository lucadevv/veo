import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDomainError } from '@veo/utils';
import { VehicleType, VehicleSegment, OfferingId } from '@veo/shared-types';
import { EligibilityGate } from './eligibility.gate';
import { InMemoryHotIndex } from '../hot-index/in-memory-hot-index';
import type { IdentityClient, IdentityDriver } from '../identity/identity-client.port';
import { bumpEligibilityFailOpen } from './dispatch.metrics';

// Espiamos SOLO el bump del fail-open (source=gate) para asertar que el gate autoritativo de PUJA instrumenta
// su fail-open; `classifyMissingAttr` se mantiene REAL (importActual) para etiquetar correctamente el attr.
vi.mock('./dispatch.metrics', async (importActual) => ({
  ...(await importActual<typeof import('./dispatch.metrics')>()),
  bumpEligibilityFailOpen: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const H3_CELL = 'cell-1';
const DRIVER = 'driver-1';

function identityFake(driver: Partial<IdentityDriver> & { found?: boolean }): IdentityClient {
  const full: IdentityDriver = {
    id: DRIVER,
    userId: 'user-1',
    currentStatus: 'AVAILABLE',
    suspendedAt: null,
    found: true,
    ...driver,
  };
  return { getDriver: async () => full };
}

async function gateWith(opts: {
  identity: IdentityClient;
  seedVehicle?: VehicleType | null;
  cacheTtlMs?: number;
}): Promise<EligibilityGate> {
  const hotIndex = new InMemoryHotIndex();
  if (opts.seedVehicle !== null) {
    await hotIndex.seed(DRIVER, -12, -77, H3_CELL, opts.seedVehicle ?? VehicleType.CAR);
  }
  // Default 0 (cache OFF) en los tests de validación pura; los tests de A4 setean un TTL explícito.
  return new EligibilityGate(opts.identity, hotIndex, opts.cacheTtlMs ?? 0);
}

/** Identity espía: cuenta los getDriver y permite mutar el snapshot devuelto (suspensión en caliente). */
function spyIdentity(initial?: Partial<IdentityDriver> & { found?: boolean }): {
  client: IdentityClient;
  calls: number;
  set: (next: Partial<IdentityDriver> & { found?: boolean }) => void;
  fail: () => void;
} {
  let current: IdentityDriver = {
    id: DRIVER,
    userId: 'user-1',
    currentStatus: 'AVAILABLE',
    suspendedAt: null,
    found: true,
    ...initial,
  };
  let failing = false;
  const state = {
    calls: 0,
    client: {
      getDriver: async (): Promise<IdentityDriver> => {
        state.calls += 1;
        if (failing) throw new Error('UNAVAILABLE');
        return current;
      },
    },
    set: (next: Partial<IdentityDriver> & { found?: boolean }) => {
      current = { ...current, ...next };
    },
    fail: () => {
      failing = true;
    },
  };
  return state;
}

async function expectForbidden(p: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
}

describe('EligibilityGate (cierre #9)', () => {
  it('eligible (AVAILABLE + !suspended + vehículo coincide) → OK', async () => {
    const gate = await gateWith({ identity: identityFake({}), seedVehicle: VehicleType.CAR });
    await expect(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR)).resolves.toBeUndefined();
  });

  it('suspendido → 403', async () => {
    const gate = await gateWith({
      identity: identityFake({ suspendedAt: new Date().toISOString() }),
      seedVehicle: VehicleType.CAR,
    });
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR));
  });

  it('no online (OFFLINE) → 403', async () => {
    const gate = await gateWith({
      identity: identityFake({ currentStatus: 'OFFLINE' }),
      seedVehicle: VehicleType.CAR,
    });
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR));
  });

  it('vehículo no coincide (bid MOTO, conductor CAR) → 403', async () => {
    const gate = await gateWith({ identity: identityFake({}), seedVehicle: VehicleType.CAR });
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.MOTO));
  });

  it('solo presencia GPS (identity NO online) → 403 (la presencia GPS no basta)', async () => {
    // El conductor SÍ está en el hot-index (GPS), pero identity lo reporta ON_TRIP → no elegible.
    const gate = await gateWith({
      identity: identityFake({ currentStatus: 'ON_TRIP' }),
      seedVehicle: VehicleType.CAR,
    });
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR));
  });

  it('desconocido en identity (found=false) → 403', async () => {
    const gate = await gateWith({
      identity: identityFake({ found: false }),
      seedVehicle: VehicleType.CAR,
    });
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR));
  });

  it('identity caído (gRPC lanza) → 403 falla-cerrado', async () => {
    const broken: IdentityClient = {
      getDriver: async () => {
        throw new Error('UNAVAILABLE');
      },
    };
    const gate = await gateWith({ identity: broken, seedVehicle: VehicleType.CAR });
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR));
  });

  it('online+no suspendido pero sin ubicación activa (vehículo desconocido) → 403', async () => {
    const gate = await gateWith({ identity: identityFake({}), seedVehicle: null });
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR));
  });
});

describe('EligibilityGate · B5-3 — elegibilidad por TIER en PUJA (paridad con FIXED)', () => {
  /** Construye el gate con un conductor elegible (AVAILABLE, no suspendido) y los attrs de vehículo dados. */
  async function gateWithAttrs(attrs?: {
    seats?: number;
    segment?: VehicleSegment;
    vehicleYear?: number;
    certifications?: import('@veo/shared-types').FleetDocumentType[];
  }): Promise<EligibilityGate> {
    const hotIndex = new InMemoryHotIndex();
    await hotIndex.seed(DRIVER, -12, -77, H3_CELL, VehicleType.CAR, attrs);
    return new EligibilityGate(identityFake({}), hotIndex, 0);
  }

  // VEO_XL requires { minSeats: 6 } (catálogo). Un CAR económico de 4 asientos NO lo cumple.
  const XL = OfferingId.VEO_XL;

  it('(a) tier INFERIOR (CAR 4 asientos, attrs presentes) RECHAZADO en un board XL (minSeats:6) → 403', async () => {
    const gate = await gateWithAttrs({
      seats: 4,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR, false, XL));
  });

  it('(b) conductor que SÍ cumple (van 7 asientos) es ACEPTADO en un board XL', async () => {
    const gate = await gateWithAttrs({
      seats: 7,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    await expect(
      gate.assertEligibleToOffer(DRIVER, VehicleType.CAR, false, XL),
    ).resolves.toBeUndefined();
  });

  it('(c) conductor LEGACY sin attrs (seats/segment/year undefined) NO se excluye (fail-open preservado) e INSTRUMENTA source=gate', async () => {
    const gate = await gateWithAttrs(); // sin attrs → faltan los 3 → 'multiple'
    await expect(
      gate.assertEligibleToOffer(DRIVER, VehicleType.CAR, false, XL),
    ).resolves.toBeUndefined();
    // El gate autoritativo de PUJA mide su PROPIO fail-open (blast-radius del submit/accept), distinto del pool.
    expect(bumpEligibilityFailOpen).toHaveBeenCalledWith('gate', 'multiple');
  });

  it('(c-bis) con attrs PRESENTES y válidos NO instrumenta el fail-open (no hay bypass)', async () => {
    const gate = await gateWithAttrs({ seats: 7, segment: VehicleSegment.ECONOMY, vehicleYear: 2022 });
    await expect(
      gate.assertEligibleToOffer(DRIVER, VehicleType.CAR, false, XL),
    ).resolves.toBeUndefined();
    expect(bumpEligibilityFailOpen).not.toHaveBeenCalled();
  });

  it('(d) board SIN category (compat N-2) → sin requires → comportamiento previo (solo vehicleType)', async () => {
    // Un CAR de 4 asientos que XL rechazaría: sin category NO hay requires que enforcar → pasa.
    const gate = await gateWithAttrs({
      seats: 4,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    await expect(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR)).resolves.toBeUndefined();
    await expect(
      gate.assertEligibleToOffer(DRIVER, VehicleType.CAR, false, undefined),
    ).resolves.toBeUndefined();
  });

  it('category DESCONOCIDA (no está en el catálogo) → sin requires → no excluye', async () => {
    const gate = await gateWithAttrs({
      seats: 4,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    await expect(
      gate.assertEligibleToOffer(DRIVER, VehicleType.CAR, false, 'no_existe'),
    ).resolves.toBeUndefined();
  });

  it('vertical con cert (ambulancia) FAIL-CLOSED: sin certs → 403 aunque los attrs basten', async () => {
    const gate = await gateWithAttrs({
      seats: 5,
      segment: VehicleSegment.MID,
      vehicleYear: 2022,
    }); // sin certs
    await expectForbidden(
      gate.assertEligibleToOffer(DRIVER, VehicleType.CAR, false, OfferingId.VEO_AMBULANCE),
    );
  });

  it('confort (minSegment MID): un ECONOMY es RECHAZADO, un PREMIUM es aceptado', async () => {
    const eco = await gateWithAttrs({
      seats: 5,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    await expectForbidden(
      eco.assertEligibleToOffer(DRIVER, VehicleType.CAR, false, OfferingId.VEO_CONFORT),
    );
    const prem = await gateWithAttrs({
      seats: 5,
      segment: VehicleSegment.PREMIUM,
      vehicleYear: 2022,
    });
    await expect(
      prem.assertEligibleToOffer(DRIVER, VehicleType.CAR, false, OfferingId.VEO_CONFORT),
    ).resolves.toBeUndefined();
  });
});

describe('EligibilityGate · A4 — cache de corto TTL (submit/list cacheado, accept fresco)', () => {
  it('dos submits dentro del TTL → UNA sola llamada a identity.getDriver (segundo del cache)', async () => {
    const spy = spyIdentity();
    const hotIndex = new InMemoryHotIndex();
    await hotIndex.seed(DRIVER, -12, -77, H3_CELL, VehicleType.CAR);
    const gate = new EligibilityGate(spy.client, hotIndex, 3_000);

    await gate.assertEligibleToOffer(DRIVER, VehicleType.CAR); // miss → 1 gRPC
    await gate.assertEligibleToOffer(DRIVER, VehicleType.CAR); // hit → 0 gRPC
    expect(spy.calls).toBe(1);
  });

  it('tras vencer el TTL, un nuevo submit vuelve a pegar a identity (segunda llamada)', async () => {
    const spy = spyIdentity();
    const hotIndex = new InMemoryHotIndex();
    await hotIndex.seed(DRIVER, -12, -77, H3_CELL, VehicleType.CAR);
    // TTL=0: cada lectura expira de inmediato → el cache nunca sirve un hit.
    const gate = new EligibilityGate(spy.client, hotIndex, 0);

    await gate.assertEligibleToOffer(DRIVER, VehicleType.CAR);
    await gate.assertEligibleToOffer(DRIVER, VehicleType.CAR);
    expect(spy.calls).toBe(2);
  });

  it('el path de ACCEPT (fresh=true) SIEMPRE pega a identity, aun con un hit cacheado', async () => {
    const spy = spyIdentity();
    const hotIndex = new InMemoryHotIndex();
    await hotIndex.seed(DRIVER, -12, -77, H3_CELL, VehicleType.CAR);
    const gate = new EligibilityGate(spy.client, hotIndex, 60_000); // TTL largo

    await gate.assertEligibleToOffer(DRIVER, VehicleType.CAR); // submit → 1 gRPC, puebla cache
    await gate.assertEligibleToOffer(DRIVER, VehicleType.CAR, true); // accept → bypass → 2 gRPC
    expect(spy.calls).toBe(2);
  });

  it('accept fresco RECHAZA a un conductor recién suspendido aunque el cache lo tenga como elegible', async () => {
    const spy = spyIdentity();
    const hotIndex = new InMemoryHotIndex();
    await hotIndex.seed(DRIVER, -12, -77, H3_CELL, VehicleType.CAR);
    const gate = new EligibilityGate(spy.client, hotIndex, 60_000);

    // Submit cachea al conductor como elegible (AVAILABLE, no suspendido).
    await expect(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR)).resolves.toBeUndefined();
    expect(spy.calls).toBe(1);
    // El cache SÍ está sirviendo el snapshot elegible: un segundo submit no-fresh NO pega a identity.
    await expect(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR)).resolves.toBeUndefined();
    expect(spy.calls).toBe(1);

    // Se SUSPENDE en caliente. El cache aún lo ve elegible (TTL 60s), pero el ACCEPT lee FRESCO y lo
    // rechaza: un conductor recién suspendido NUNCA se cuela al match por un snapshot stale.
    spy.set({ suspendedAt: new Date().toISOString() });
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR, true));
    expect(spy.calls).toBe(2); // el accept bypaseó el cache (re-pegó a identity)
  });

  it('un error de red NUNCA se cachea (falla-cerrado): el siguiente intento RE-INTENTA identity', async () => {
    const spy = spyIdentity();
    const hotIndex = new InMemoryHotIndex();
    await hotIndex.seed(DRIVER, -12, -77, H3_CELL, VehicleType.CAR);
    const gate = new EligibilityGate(spy.client, hotIndex, 60_000);

    spy.fail(); // identity caído
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR)); // 1er intento → 403
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR)); // 2do → RE-PEGA (no cacheó el error)
    expect(spy.calls).toBe(2);
  });

  it('un conductor suspendido es rechazado y NO se cachea como elegible (solo lecturas exitosas-autoritativas)', async () => {
    const spy = spyIdentity({ suspendedAt: new Date().toISOString() });
    const hotIndex = new InMemoryHotIndex();
    await hotIndex.seed(DRIVER, -12, -77, H3_CELL, VehicleType.CAR);
    const gate = new EligibilityGate(spy.client, hotIndex, 60_000);

    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR));
    // Se cacheó el snapshot AUTORITATIVO (suspendido) — un segundo submit lo sirve del cache, sigue 403.
    await expectForbidden(gate.assertEligibleToOffer(DRIVER, VehicleType.CAR));
    expect(spy.calls).toBe(1); // el rechazo por suspensión SÍ es una lectura exitosa cacheable
  });
});

describe('EligibilityGate · H11 — cota del cache in-proc (lazy-evict de vencidos + cap de tamaño)', () => {
  /** Acceso al Map privado para probar que la cota se respeta (memoria acotada). */
  function cacheSize(gate: EligibilityGate): number {
    return (gate as unknown as { cache: Map<string, unknown> }).cache.size;
  }

  it('una entrada VENCIDA se BORRA al leerla (el Map se achica, no solo se saltea)', async () => {
    const spy = spyIdentity();
    const hotIndex = new InMemoryHotIndex();
    await hotIndex.seed(DRIVER, -12, -77, H3_CELL, VehicleType.CAR);
    // TTL mínimo (1ms): la entrada vence casi de inmediato.
    const gate = new EligibilityGate(spy.client, hotIndex, 1);

    await gate.assertEligibleToOffer(DRIVER, VehicleType.CAR); // puebla el cache
    expect(cacheSize(gate)).toBe(1);

    await new Promise((r) => setTimeout(r, 5)); // deja vencer la entrada
    // Una lectura encuentra la entrada VENCIDA: la BORRA (lazy-evict) antes de re-pegar a identity.
    // Tras re-pegar, la re-puebla → size sigue acotado en 1 (no crece con cada miss).
    await gate.assertEligibleToOffer(DRIVER, VehicleType.CAR);
    expect(spy.calls).toBe(2); // re-pegó (la vencida no sirvió un hit)
    expect(cacheSize(gate)).toBe(1); // se borró la vieja y se re-insertó: NO acumula
  });

  it('el cap de tamaño ACOTA el Map (la entrada más vieja se evicta al superarlo)', async () => {
    const spy = spyIdentity();
    const hotIndex = new InMemoryHotIndex();
    const gate = new EligibilityGate(spy.client, hotIndex, 60_000);

    // Inunda el cache con MUCHOS drivers distintos. found=false es una lectura exitosa-cacheable, así
    // que cada driver puebla una entrada sin tocar el hot-index. Superamos el cap (10_000) por margen.
    const total = 10_050;
    for (let i = 0; i < total; i++) {
      spy.set({ found: false });
      // found=false → ForbiddenError ('desconocido en identity'), pero la lectura SÍ se cachea.
      await expectForbidden(gate.assertEligibleToOffer(`driver-${i}`, VehicleType.CAR));
    }
    // El Map quedó acotado en el cap (no en 10_050): la cota dura evictó las entradas más viejas.
    expect(cacheSize(gate)).toBeLessThanOrEqual(10_000);
    expect(cacheSize(gate)).toBeGreaterThan(9_000); // sigue cacheando: no se vació
  });
});
