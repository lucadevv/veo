import { describe, it, expect, vi } from 'vitest';
import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@veo/utils';
import { DriverStatus, KycStatus, FleetDocumentStatus } from '@veo/shared-types';
import { toH3, neighbors, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { PublishedTripState, PricingMode, ModoReserva } from '../generated/prisma';
import { PublishedTripsService } from './published-trips.service';
import type { CostCapService, PriceCapInput } from '../cost-cap/cost-cap.service';
import type {
  PublishedTripsRepository,
  CreatePublishedTripData,
  UpdatePublishedTripData,
  OutboxIntent,
} from './published-trips.repository';
import type { IdentityClient, IdentityDriver } from '../identity/identity-client.port';
import type { IdentityBatchClient, PublicDriver } from '../identity/identity-batch-client.port';
import type { FleetClient, FleetVehicle, FleetVehicleView } from '../fleet/fleet-client.port';
import { BACKGROUND_CHECK_CLEARED, VEHICLE_STATUS_OPERABLE } from '../domain/driver-eligibility';
import { CANCELABLE_STATES } from '../domain/published-trip-state';
import type { SearchPublishedTripsDto } from './dto/search-published-trips.dto';
import type { SearchH3Config } from './published-trips.service';
import type { SearchRadiusReader } from '../search-radius/carpool-search-config.service';
import type { CreatePublishedTripDto } from './dto/create-published-trip.dto';
import type { UpdatePublishedTripDto } from './dto/update-published-trip.dto';

/**
 * Smoke + GATES F1a + ENDURECIMIENTO F1 del PublishedTripsService (sin Nest DI ni DB — repo/clientes fake,
 * espeja la convención vitest del repo). Cubre: happy path de publicar, gate del conductor, validación de
 * vehículo anti-IDOR, editar/cancelar (ownership + estado), GET /mine scoped+paginado, relleno de
 * precioPorTramo, y los FIXES F1: idempotencia de publish (namespaceada por driverId, anti-cross-tenant),
 * UPDATE atómico (where condicionado → ConflictError ante mismatch), integridad stopovers↔tramos.
 */
const VEHICLE_ID = '00000000-0000-0000-0000-0000000000aa';
const DRIVER_ID = '00000000-0000-0000-0000-0000000000d1';
const IDEMPOTENCY_KEY = '018f8e3a-0000-7000-8000-000000000001'; // UUID válido por intento de submit
const REQUEST_DEDUP_PREFIX = (driverId: string) => `published:req:${driverId}:`;

function makeDto(over: Partial<CreatePublishedTripDto> = {}): CreatePublishedTripDto {
  return {
    vehicleId: VEHICLE_ID,
    origenLat: -12.05,
    origenLon: -77.04,
    destinoLat: -13.52,
    destinoLon: -71.97,
    fechaHoraSalida: new Date(Date.now() + 86_400_000).toISOString(), // mañana
    asientosTotales: 3,
    precioBase: 4500, // céntimos PEN
    modoReserva: ModoReserva.REVISION_CADA_SOLICITUD,
    ...over,
  };
}

function makeRepo() {
  const createWithEvent = vi.fn(async (data: CreatePublishedTripData, _intent: OutboxIntent) => ({
    ...data,
    estado: PublishedTripState.PUBLICADO,
  }));
  const createWithEventIdempotent = vi.fn(
    async (
      _dedupKey: string,
      _expectedDriverId: string,
      data: CreatePublishedTripData,
      _intent: OutboxIntent,
    ) => ({ ...data, estado: PublishedTripState.PUBLICADO }),
  );
  const updateWithEvent = vi.fn(
    async (
      id: string,
      _driverId: string,
      _allowedStates: readonly PublishedTripState[],
      data: UpdatePublishedTripData,
      _intent: OutboxIntent,
    ) => ({ id, ...data }),
  );
  const cancelByAdminWithEvent = vi.fn(
    async (
      id: string,
      _allowedStates: readonly PublishedTripState[],
      data: UpdatePublishedTripData,
      _intent: OutboxIntent,
    ) => ({ id, ...data }),
  );
  const findById = vi.fn();
  const findByIdFromPrimary = vi.fn();
  const findByDriverId = vi.fn(async () => []);
  const searchByRoute = vi.fn(async () => []);
  const countAvailableByOriginRing = vi.fn(async () => 0);
  const sampleAvailableOriginsByRing = vi.fn(async () => [] as { lat: number; lon: number }[]);
  const listActiveCarpools = vi.fn(async (): Promise<unknown[]> => []);
  const aggregateActiveCarpools = vi.fn(async () => ({
    count: 0,
    asientosTotales: 0,
    asientosDisponibles: 0,
  }));
  const countByState = vi.fn(async () => 0);
  const repo = {
    createWithEvent,
    createWithEventIdempotent,
    updateWithEvent,
    cancelByAdminWithEvent,
    findById,
    findByIdFromPrimary,
    findByDriverId,
    searchByRoute,
    countAvailableByOriginRing,
    sampleAvailableOriginsByRing,
    listActiveCarpools,
    aggregateActiveCarpools,
    countByState,
  } as unknown as PublishedTripsRepository;
  return {
    repo,
    createWithEvent,
    createWithEventIdempotent,
    updateWithEvent,
    cancelByAdminWithEvent,
    findById,
    findByIdFromPrimary,
    findByDriverId,
    searchByRoute,
    countAvailableByOriginRing,
    sampleAvailableOriginsByRing,
    listActiveCarpools,
    aggregateActiveCarpools,
    countByState,
  };
}

/** Conductor ELEGIBLE por default; los tests negativos sobrescriben el eje que prueban. */
function makeDriver(over: Partial<IdentityDriver> = {}): IdentityDriver {
  return {
    id: DRIVER_ID,
    userId: '00000000-0000-0000-0000-0000000000u1',
    currentStatus: DriverStatus.AVAILABLE,
    backgroundCheckStatus: BACKGROUND_CHECK_CLEARED,
    kycStatus: KycStatus.VERIFIED,
    suspendedAt: null,
    found: true,
    name: 'Conductor Demo',
    averageRating: 4.8,
    ...over,
  };
}

/** Vehículo PROPIO + vigente por default; los tests negativos sobrescriben. */
function makeVehicle(over: Partial<FleetVehicle> = {}): FleetVehicle {
  return {
    id: VEHICLE_ID,
    docStatus: FleetDocumentStatus.VALID,
    active: true,
    status: VEHICLE_STATUS_OPERABLE,
    vehicleType: 'CAR',
    ...over,
  };
}

function makeIdentity(driver: IdentityDriver | (() => Promise<IdentityDriver>)): IdentityClient {
  const getDriver = vi.fn(typeof driver === 'function' ? driver : async () => driver);
  return { getDriver };
}

function makeFleet(
  vehicles: FleetVehicle[] | (() => Promise<FleetVehicle[]>),
  vehicle: FleetVehicleView | (() => Promise<FleetVehicleView>) = makeVehicleView(),
  // Lote 3b: operabilidad batch para el filtro de la búsqueda. Por default TODOS los vehículos pedidos son
  // OPERABLES (los tests de búsqueda existentes esperan que sus ofertas se devuelvan). Override: un Map fijo
  // (qué vehículos son operables) o una función que LANZA (fleet caída → best-effort, no filtra por vehículo).
  operability?:
    | Map<string, FleetVehicleView>
    | ((ids: readonly string[]) => Promise<Map<string, FleetVehicleView>>),
): FleetClient {
  const getDriverVehicles = vi.fn(typeof vehicles === 'function' ? vehicles : async () => vehicles);
  const getVehicle = vi.fn(typeof vehicle === 'function' ? vehicle : async () => vehicle);
  const getVehiclesOperability = vi.fn(
    typeof operability === 'function'
      ? operability
      : async (ids: readonly string[]) =>
          operability ?? new Map(ids.map((id) => [id, makeVehicleView({ id })])),
  );
  return { getDriverVehicles, getVehicle, getVehiclesOperability };
}

/**
 * FleetVehicleView fake (detalle F2 · Lote 3) — display + ejes de OPERABILIDAD. Por default OPERABLE (found +
 * active + status ACTIVE + docs VALID): el detalle pasa el gate y devuelve la cara pública. Los tests del gate
 * sobrescriben el eje que prueban (found:false / active:false / status / docStatus).
 */
function makeVehicleView(over: Partial<FleetVehicleView> = {}): FleetVehicleView {
  return {
    id: VEHICLE_ID,
    make: 'Toyota',
    model: 'Yaris',
    color: 'Gris',
    plate: 'ABC-123',
    vehicleType: 'CAR',
    found: true,
    active: true,
    status: VEHICLE_STATUS_OPERABLE,
    docStatus: FleetDocumentStatus.VALID,
    ...over,
  };
}

/**
 * PublicDriver ELEGIBLE por default (FIX 3): trae los ejes de elegibilidad en estado apto (no suspendido, KYC
 * VERIFIED, found). Los tests negativos sobrescriben el eje que prueban.
 */
function makePublicDriver(id: string, over: Partial<PublicDriver> = {}): PublicDriver {
  return {
    id,
    name: `Driver ${id}`,
    averageRating: 4.5,
    currentStatus: DriverStatus.AVAILABLE,
    suspendedAt: '', // proto3 default: "" cuando NO está suspendido (nunca null)
    kycStatus: KycStatus.VERIFIED,
    backgroundCheckStatus: BACKGROUND_CHECK_CLEARED, // FIX 1·F2: eje del predicado ÚNICO (antecedentes CLEARED)
    found: true,
    ...over,
  };
}

/**
 * IdentityBatchClient fake (enriquecimiento anti-N+1). Cuenta las invocaciones: la aserción central de F2 es
 * "UNA sola llamada getDriversByIds para N viajes". Por default devuelve un PublicDriver ELEGIBLE por cada id.
 */
function makeIdentityBatch(impl?: (ids: string[]) => Promise<PublicDriver[]>): {
  client: IdentityBatchClient;
  getDriversByIds: ReturnType<typeof vi.fn>;
} {
  const getDriversByIds = vi.fn(
    impl ?? (async (ids: string[]) => ids.map((id) => makePublicDriver(id))),
  );
  return { client: { getDriversByIds }, getDriversByIds };
}

/** Config de búsqueda H3 fake: k=1 base, k=2 expandido (defaults del env). Override por test. */
function makeSearchConfig(over: Partial<SearchH3Config> = {}): SearchH3Config {
  return { kRing: 1, kRingExpand: 2, ...over };
}

/**
 * Reader del radio fake (SEARCH_RADIUS_READER): envuelve un SearchH3Config { kRing, kRingExpand } en el
 * contrato que consume el service (getKRings + getResolvedRadii). Los radios km se derivan de los k
 * (km = k × 0.3, la inversa aproximada del mapeo real) — el radar preview solo necesita coherencia k↔km.
 */
function makeSearchReader(config: SearchH3Config = makeSearchConfig()): SearchRadiusReader {
  return {
    getKRings: async () => config,
    getResolvedRadii: async () => ({
      baseRadiusKm: config.kRing * 0.3,
      expandRadiusKm: config.kRingExpand * 0.3,
      baseKRing: config.kRing,
      expandKRing: config.kRingExpand,
    }),
  };
}

/**
 * CostCapService fake (gate F1b): por default PASA (no-op resuelto). Los tests que NO prueban el tope lo
 * dejan así (aislados del motor de mapas). Los tests del gate F1b inyectan un CostCapService REAL con un
 * MapsClient MOCKEADO (ver describe '· gate F1b') — NUNCA se llama a OSRM real en tests.
 */
function makeCostCap(assertPriceCap: (input: PriceCapInput) => Promise<void> = async () => {}): {
  costCap: CostCapService;
  assertPriceCap: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(assertPriceCap);
  const costCap = { assertPriceCap: spy } as unknown as CostCapService;
  return { costCap, assertPriceCap: spy };
}

/** Arma el service con clientes elegibles por default (override por test). */
function makeService(opts: {
  repo: PublishedTripsRepository;
  identity?: IdentityClient;
  identityBatch?: IdentityBatchClient;
  fleet?: FleetClient;
  costCap?: CostCapService;
  searchConfig?: SearchH3Config;
  searchReader?: SearchRadiusReader;
}) {
  const identity = opts.identity ?? makeIdentity(makeDriver());
  const identityBatch = opts.identityBatch ?? makeIdentityBatch().client;
  const fleet = opts.fleet ?? makeFleet([makeVehicle()]);
  const costCap = opts.costCap ?? makeCostCap().costCap;
  const searchReader = opts.searchReader ?? makeSearchReader(opts.searchConfig ?? makeSearchConfig());
  return new PublishedTripsService(
    opts.repo,
    identity,
    identityBatch,
    fleet,
    costCap,
    searchReader,
  );
}

describe('PublishedTripsService · publish (happy path + relleno precioPorTramo)', () => {
  it('publica: PUBLICADO, FIJO server-side, asientosDisponibles == totales, evento booking.published', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });

    await service.publish(DRIVER_ID, makeDto({ asientosTotales: 3 }));

    expect(createWithEventIdempotent).toHaveBeenCalledOnce();
    const call = createWithEventIdempotent.mock.calls[0];
    if (!call) throw new Error('createWithEventIdempotent no fue llamado');
    const [, expectedDriverId, data, intent] = call;
    expect(expectedDriverId).toBe(DRIVER_ID); // ownership esperado en recovery (anti-IDOR cross-tenant)
    expect(data.driverId).toBe(DRIVER_ID); // server-truth, no del body
    expect(data.estado).toBe(PublishedTripState.PUBLICADO);
    expect(data.pricingMode).toBe(PricingMode.FIJO);
    expect(data.asientosDisponibles).toBe(3);
    expect(data.pais).toBe('PE');
    expect(data.moneda).toBe('PEN');
    expect(intent.eventType).toBe('booking.published');
    expect(intent.aggregateId).toBe(data.id);
    // F2 — poblado de H3 al publicar (cierra el gap de F1a): origin/dest H3 calculados con @veo/utils y
    // persistidos en la MISMA tx del create. Se asume que coinciden con toH3(origen/destino, res 9).
    expect(data.originH3).toBe(toH3({ lat: -12.05, lon: -77.04 }, DISPATCH_H3_RESOLUTION));
    expect(data.destH3).toBe(toH3({ lat: -13.52, lon: -71.97 }, DISPATCH_H3_RESOLUTION));
    expect(typeof data.originH3).toBe('string');
  });

  it('rellena precioPorTramo full-route con precioBase si no se envía (sin stopovers → orden 1)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });

    await service.publish(DRIVER_ID, makeDto({ precioBase: 7000, precioPorTramo: undefined }));

    const data = createWithEventIdempotent.mock.calls[0]![2];
    expect(data.precioPorTramo).toEqual([{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 7000 }]);
  });

  it('rellena precioPorTramo hasta el destino = max(stopovers)+1 (hito propio tras el último stopover)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });

    await service.publish(
      DRIVER_ID,
      makeDto({
        precioBase: 5000,
        precioPorTramo: [],
        stopovers: [
          { lat: -12.1, lon: -77.0, orden: 1 },
          { lat: -12.2, lon: -77.0, orden: 2 },
        ],
      }),
    );

    const data = createWithEventIdempotent.mock.calls[0]![2];
    // FIX 1 — destino = max(stopovers)+1 = 3 (hito propio DESPUÉS del último stopover), no max=2.
    expect(data.precioPorTramo).toEqual([{ desdeOrden: 0, hastaOrden: 3, precioCentimos: 5000 }]);
  });

  it('respeta precioPorTramo si el cliente lo envía (referenciando hitos válidos)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });
    const tramos = [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 3000 }];

    await service.publish(DRIVER_ID, makeDto({ precioPorTramo: tramos }));

    expect(createWithEventIdempotent.mock.calls[0]![2].precioPorTramo).toEqual(tramos);
  });

  it('rechaza fechaHoraSalida en el pasado (viaje PROGRAMADO debe ser futuro)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });
    await expect(
      service.publish(
        DRIVER_ID,
        makeDto({ fechaHoraSalida: new Date(Date.now() - 1000).toISOString() }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });
});

describe('PublishedTripsService · idempotencia de publish (FIX 2, namespaceada por driverId)', () => {
  it('con Idempotency-Key: dedupKey = published:req:{driverId}:{key} (driverId server-truth PRIMERO)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });

    await service.publish(DRIVER_ID, makeDto(), IDEMPOTENCY_KEY);

    const [dedupKey, expectedDriverId, data] = createWithEventIdempotent.mock.calls[0]!;
    expect(dedupKey).toBe(`${REQUEST_DEDUP_PREFIX(DRIVER_ID)}${IDEMPOTENCY_KEY}`);
    expect(expectedDriverId).toBe(DRIVER_ID);
    expect(data.dedupKey).toBe(dedupKey);
  });

  it('ANTI-CROSS-TENANT: dos conductores con el MISMO Idempotency-Key → dedupKeys DISTINTAS', async () => {
    const DRIVER_A = '00000000-0000-0000-0000-0000000000a1';
    const DRIVER_B = '00000000-0000-0000-0000-0000000000b2';

    const a = makeRepo();
    const serviceA = makeService({
      repo: a.repo,
      identity: makeIdentity(makeDriver({ id: DRIVER_A })),
    });
    await serviceA.publish(DRIVER_A, makeDto(), IDEMPOTENCY_KEY);

    const b = makeRepo();
    const serviceB = makeService({
      repo: b.repo,
      identity: makeIdentity(makeDriver({ id: DRIVER_B })),
    });
    await serviceB.publish(DRIVER_B, makeDto(), IDEMPOTENCY_KEY);

    const keyA = a.createWithEventIdempotent.mock.calls[0]![0];
    const keyB = b.createWithEventIdempotent.mock.calls[0]![0];
    expect(keyA).not.toBe(keyB); // mismo header, distinto driverId → no colisionan (B jamás toca la de A)
    expect(a.createWithEventIdempotent.mock.calls[0]![1]).toBe(DRIVER_A);
    expect(b.createWithEventIdempotent.mock.calls[0]![1]).toBe(DRIVER_B);
  });

  it('sin Idempotency-Key: key única server-side igual namespaceada por driverId (no dedupea, no lockea)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });

    await service.publish(DRIVER_ID, makeDto()); // sin header

    const dedupKey = createWithEventIdempotent.mock.calls[0]![0];
    expect(dedupKey.startsWith(REQUEST_DEDUP_PREFIX(DRIVER_ID))).toBe(true);
    // No es el header (no hay): es una key única server-side → cada submit es nuevo.
    expect(dedupKey).not.toBe(`${REQUEST_DEDUP_PREFIX(DRIVER_ID)}${IDEMPOTENCY_KEY}`);
  });

  it('Idempotency-Key malformado (no UUID) → ValidationError (no se degrada en silencio)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });
    await expect(service.publish(DRIVER_ID, makeDto(), 'no-es-un-uuid')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });
});

describe('PublishedTripsService · integridad stopovers↔tramos (FIX 3)', () => {
  it('tramo apuntando a un orden de stopover INEXISTENTE → ValidationError (publish), no escribe', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });
    // hitos válidos: { 0, 1, 2, 3 } (origen=0, stopovers 1 y 2, destino=3). hastaOrden=9 es huérfano.
    await expect(
      service.publish(
        DRIVER_ID,
        makeDto({
          stopovers: [
            { lat: -12.1, lon: -77.0, orden: 1 },
            { lat: -12.2, lon: -77.0, orden: 2 },
          ],
          precioPorTramo: [{ desdeOrden: 0, hastaOrden: 9, precioCentimos: 3000 }],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('tramos que referencian hitos válidos → publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });
    await service.publish(
      DRIVER_ID,
      makeDto({
        stopovers: [
          { lat: -12.1, lon: -77.0, orden: 1 },
          { lat: -12.2, lon: -77.0, orden: 2 },
        ],
        // hitos válidos: { 0, 1, 2, 3 } (destino = max+1 = 3). tramos 0→1 y 1→2 son válidos.
        precioPorTramo: [
          { desdeOrden: 0, hastaOrden: 1, precioCentimos: 2000 },
          { desdeOrden: 1, hastaOrden: 2, precioCentimos: 2500 },
        ],
      }),
    );
    expect(createWithEventIdempotent).toHaveBeenCalledOnce();
  });

  it('update con tramos huérfanos respecto a los stopovers finales → ValidationError, no edita', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
      stopovers: [{ lat: -12.1, lon: -77.0, orden: 1 }],
      precioPorTramo: [{ desdeOrden: 0, hastaOrden: 2, precioCentimos: 2000 }],
    });
    const service = makeService({ repo });
    // El PATCH reduce los stopovers a [] → hitos válidos { 0, 1 } → el tramo viejo 0→2 queda huérfano.
    await expect(service.update('x', DRIVER_ID, { stopovers: [] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(updateWithEvent).not.toHaveBeenCalled();
  });
});

describe('PublishedTripsService · GATE del conductor (F1a)', () => {
  it('conductor suspendido (suspendedAt) → 403, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      identity: makeIdentity(makeDriver({ suspendedAt: new Date().toISOString() })),
    });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ForbiddenError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('conductor con currentStatus SUSPENDED → 403, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      identity: makeIdentity(makeDriver({ currentStatus: DriverStatus.SUSPENDED })),
    });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ForbiddenError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('conductor no encontrado (found=false) → 403, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo, identity: makeIdentity(makeDriver({ found: false })) });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ForbiddenError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('KYC no VERIFIED → 403, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      identity: makeIdentity(makeDriver({ kycStatus: KycStatus.PENDING })),
    });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ForbiddenError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('antecedentes no CLEARED → 403, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      identity: makeIdentity(makeDriver({ backgroundCheckStatus: 'PENDING' })),
    });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ForbiddenError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('identity caído (la llamada lanza) → FALLA-CERRADO con 403, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      identity: makeIdentity(async () => {
        throw new Error('DEADLINE_EXCEEDED');
      }),
    });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ForbiddenError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('conductor ELEGIBLE → publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });
    await service.publish(DRIVER_ID, makeDto());
    expect(createWithEventIdempotent).toHaveBeenCalledOnce();
  });
});

describe('PublishedTripsService · validación de VEHÍCULO anti-IDOR (F1a)', () => {
  it('vehículo AJENO (no en la lista del conductor) → 403 IDOR, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      fleet: makeFleet([makeVehicle({ id: '00000000-0000-0000-0000-0000000000bb' })]),
    });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ForbiddenError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('vehículo propio pero INACTIVO → 400, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo, fleet: makeFleet([makeVehicle({ active: false })]) });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ValidationError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('vehículo propio pero status NO operable → 400, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      fleet: makeFleet([makeVehicle({ status: 'PENDING_REVIEW' })]),
    });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ValidationError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('vehículo propio pero docs VENCIDOS (EXPIRED) → 400, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      fleet: makeFleet([makeVehicle({ docStatus: FleetDocumentStatus.EXPIRED })]),
    });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ValidationError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('vehículo con docs EXPIRING_SOON (vigente hoy) → publica OK (unificado con on-demand · decisión del dueño)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      fleet: makeFleet([makeVehicle({ docStatus: FleetDocumentStatus.EXPIRING_SOON })]),
    });
    // EXPIRING_SOON ya NO frena el publish del carpooling: solo EXPIRED bloquea.
    await service.publish(DRIVER_ID, makeDto());
    expect(createWithEventIdempotent).toHaveBeenCalledOnce();
  });

  it('fleet caído (la llamada lanza) → FALLA-CERRADO con 403, no publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({
      repo,
      fleet: makeFleet(async () => {
        throw new Error('UNAVAILABLE');
      }),
    });
    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(ForbiddenError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('vehículo PROPIO + vigente → publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const service = makeService({ repo });
    await service.publish(DRIVER_ID, makeDto());
    expect(createWithEventIdempotent).toHaveBeenCalledOnce();
  });
});

describe('PublishedTripsService · editar (F1a ownership + estado + UPDATE atómico)', () => {
  const dto: UpdatePublishedTripDto = { precioBase: 6000 };

  it('no-dueño → 404 (no filtra existencia), no edita', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: 'OTRO_DRIVER',
      estado: PublishedTripState.PUBLICADO,
    });
    const service = makeService({ repo });
    await expect(service.update('x', DRIVER_ID, dto)).rejects.toBeInstanceOf(NotFoundError);
    expect(updateWithEvent).not.toHaveBeenCalled();
  });

  it('oferta inexistente → 404', async () => {
    const { repo, findByIdFromPrimary } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce(null);
    const service = makeService({ repo });
    await expect(service.update('missing', DRIVER_ID, dto)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('dueño + PUBLICADO → edita atómico (allowedStates=[PUBLICADO]) y emite booking.updated', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
    });
    const service = makeService({ repo });
    await service.update('x', DRIVER_ID, { precioBase: 6000, asientosTotales: 4 });
    expect(updateWithEvent).toHaveBeenCalledOnce();
    const [id, driverId, allowedStates, data, intent] = updateWithEvent.mock.calls[0]!;
    expect(id).toBe('x');
    expect(driverId).toBe(DRIVER_ID); // scope anti-IDOR a nivel de fila
    expect(allowedStates).toEqual([PublishedTripState.PUBLICADO]); // where condicionado por estado (TOCTOU)
    expect(data.precioBase).toBe(6000);
    expect(data.asientosTotales).toBe(4);
    expect(data.asientosDisponibles).toBe(4); // sincronizado (PUBLICADO: 0 confirmadas)
    expect(intent.eventType).toBe('booking.updated');
  });

  it('PATCH vacío (data={}) → NO-OP idempotente: devuelve el actual, NO escribe ni emite booking.updated (FIX 4)', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    const current = {
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
    };
    findByIdFromPrimary.mockResolvedValueOnce(current);
    const service = makeService({ repo });

    const result = await service.update('x', DRIVER_ID, {});

    expect(result).toBe(current); // devuelve el recurso ACTUAL tal cual (ya leído del PRIMARY)
    expect(updateWithEvent).not.toHaveBeenCalled(); // ni escritura ni evento espurio
  });

  it('viaje EN_RUTA → 400 (no editable, chequeo temprano), no edita', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.EN_RUTA,
    });
    const service = makeService({ repo });
    await expect(service.update('x', DRIVER_ID, dto)).rejects.toBeInstanceOf(ValidationError);
    expect(updateWithEvent).not.toHaveBeenCalled();
  });

  it('viaje PARCIALMENTE_RESERVADO (con confirmadas) → 400, no edita', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PARCIALMENTE_RESERVADO,
    });
    const service = makeService({ repo });
    await expect(service.update('x', DRIVER_ID, dto)).rejects.toBeInstanceOf(ValidationError);
    expect(updateWithEvent).not.toHaveBeenCalled();
  });

  it('TOCTOU: el read dice PUBLICADO pero el WHERE atómico no matchea (estado cambió) → ConflictError (no 500)', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO, // read stale: pasó el chequeo temprano
    });
    // El repo (where condicionado) ya no matchea porque la PRIMARIA cambió → traduce P2025 a ConflictError.
    updateWithEvent.mockRejectedValueOnce(
      new ConflictError('El viaje cambió de estado, recargá', {}),
    );
    const service = makeService({ repo });
    await expect(service.update('x', DRIVER_ID, dto)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('PublishedTripsService · cancelar (F1a ownership + máquina + UPDATE atómico)', () => {
  it('no-dueño → 404 (no filtra existencia), no cancela', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: 'OTRO_DRIVER',
      estado: PublishedTripState.PUBLICADO,
    });
    const service = makeService({ repo });
    await expect(service.cancel('x', DRIVER_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(updateWithEvent).not.toHaveBeenCalled();
  });

  it('dueño + PUBLICADO → CANCELADO atómico (allowedStates=CANCELABLE_STATES), emite booking.cancelled', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
    });
    const service = makeService({ repo });
    await service.cancel('x', DRIVER_ID);
    expect(updateWithEvent).toHaveBeenCalledOnce();
    const [, driverId, allowedStates, data, intent] = updateWithEvent.mock.calls[0]!;
    expect(driverId).toBe(DRIVER_ID);
    expect(allowedStates).toEqual(CANCELABLE_STATES); // estados cancelables derivados de la máquina
    expect(data.estado).toBe(PublishedTripState.CANCELADO);
    expect(intent.eventType).toBe('booking.cancelled');
    expect(intent.payload.estadoAnterior).toBe(PublishedTripState.PUBLICADO);
  });

  it('viaje EN_RUTA → la máquina rechaza (chequeo temprano, no cancelable), no emite', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.EN_RUTA,
    });
    const service = makeService({ repo });
    await expect(service.cancel('x', DRIVER_ID)).rejects.toBeTruthy();
    expect(updateWithEvent).not.toHaveBeenCalled();
  });

  it('re-cancelar (carrera TOCTOU): where atómico no matchea CANCELADO → ConflictError, NO emite 2º evento', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    // El read temprano ve PUBLICADO (stale) → pasa assertTransition; pero la PRIMARIA ya está CANCELADA →
    // CANCELADO ∉ CANCELABLE_STATES → 0 filas → P2025 → ConflictError. No se emite un segundo booking.cancelled.
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
    });
    updateWithEvent.mockRejectedValueOnce(
      new ConflictError('El viaje cambió de estado, recargá', {}),
    );
    const service = makeService({ repo });
    await expect(service.cancel('x', DRIVER_ID)).rejects.toBeInstanceOf(ConflictError);
  });

  it('CANCELABLE_STATES no incluye estados terminales/EN_RUTA (derivado de la máquina)', () => {
    expect(CANCELABLE_STATES).not.toContain(PublishedTripState.EN_RUTA);
    expect(CANCELABLE_STATES).not.toContain(PublishedTripState.COMPLETADO);
    expect(CANCELABLE_STATES).not.toContain(PublishedTripState.CANCELADO);
    expect(CANCELABLE_STATES).toContain(PublishedTripState.PUBLICADO);
  });
});

describe('PublishedTripsService · cancelar ADMIN (finance/carpooling · máquina + UPDATE atómico SIN ownership)', () => {
  it('carpool activo → CANCELADO atómico (allowedStates=CANCELABLE_STATES, sin driverId), emite booking.cancelled con actor admin', async () => {
    const { repo, findByIdFromPrimary, cancelByAdminWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PARCIALMENTE_RESERVADO,
    });
    const service = makeService({ repo });

    const res = await service.cancelByAdmin('x', 'admin-1');

    expect(cancelByAdminWithEvent).toHaveBeenCalledOnce();
    const [id, allowedStates, data, intent] = cancelByAdminWithEvent.mock.calls[0]!;
    expect(id).toBe('x');
    // REUSA la máquina: cancelable derivado de la tabla de transiciones (no strings sueltos). Sin driverId (admin).
    expect(allowedStates).toEqual(CANCELABLE_STATES);
    expect(data.estado).toBe(PublishedTripState.CANCELADO);
    expect(intent.eventType).toBe('booking.cancelled'); // MISMO evento que el cancel del conductor
    expect(intent.payload.canceledBy).toBe('admin');
    expect(intent.payload.adminUserId).toBe('admin-1');
    expect(intent.payload.estadoAnterior).toBe(PublishedTripState.PARCIALMENTE_RESERVADO);
    expect(intent.payload.driverId).toBe(DRIVER_ID); // driverId del trip (para el fan-out), no del admin
    expect(res.estado).toBe(PublishedTripState.CANCELADO);
    expect(res.estadoAnterior).toBe(PublishedTripState.PARCIALMENTE_RESERVADO);
  });

  it('carpool inexistente → 404, no cancela (admin: sin chequeo de ownership)', async () => {
    const { repo, findByIdFromPrimary, cancelByAdminWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce(null);
    const service = makeService({ repo });
    await expect(service.cancelByAdmin('x', 'admin-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(cancelByAdminWithEvent).not.toHaveBeenCalled();
  });

  it('carpool EN_RUTA → la máquina rechaza (chequeo temprano, no cancelable), no emite', async () => {
    const { repo, findByIdFromPrimary, cancelByAdminWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.EN_RUTA,
    });
    const service = makeService({ repo });
    await expect(service.cancelByAdmin('x', 'admin-1')).rejects.toBeTruthy();
    expect(cancelByAdminWithEvent).not.toHaveBeenCalled();
  });

  it('re-cancelar (TOCTOU): where atómico no matchea → ConflictError, NO emite 2º evento', async () => {
    const { repo, findByIdFromPrimary, cancelByAdminWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
    });
    cancelByAdminWithEvent.mockRejectedValueOnce(
      new ConflictError('El viaje cambió de estado, recargá', {}),
    );
    const service = makeService({ repo });
    await expect(service.cancelByAdmin('x', 'admin-1')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('PublishedTripsService · DETALLE admin de carpool (monitoreo · sin gates passenger-facing)', () => {
  const makeDetailRow = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    driverId: DRIVER_ID,
    vehicleId: VEHICLE_ID,
    estado: PublishedTripState.LLENO,
    fechaHoraSalida: new Date('2026-08-01T12:00:00Z'),
    modoReserva: ModoReserva.INSTANT_BOOKING,
    pais: 'PE',
    moneda: 'PEN',
    origenLat: -12.1,
    origenLon: -77.0,
    originH3: 'h1',
    destinoLat: -12.0,
    destinoLon: -77.1,
    destH3: 'h2',
    stopovers: [{ lat: -12.05, lon: -77.05, orden: 1 }],
    asientosTotales: 4,
    asientosDisponibles: 1,
    precioBase: 800,
    ...over,
  });

  it('devuelve la oferta con cost-share derivable + conductor + vehículo, en CUALQUIER estado (sin gate)', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce(makeDetailRow());
    const identityBatch = makeIdentityBatch((ids) =>
      Promise.resolve(ids.map((id) => makePublicDriver(id, { name: 'José R', averageRating: 4.9 }))),
    ).client;
    const fleet = makeFleet(
      [makeVehicle()],
      makeVehicleView({ make: 'Toyota', model: 'Yaris', plate: 'ABC-123', color: 'Gris' }),
    );
    const service = makeService({ repo, identityBatch, fleet });

    const d = await service.getAdminCarpoolDetail('c1');

    expect(d.estado).toBe(PublishedTripState.LLENO); // NO se filtra por searchable
    expect(d.asientosReservados).toBe(3); // 4 − 1
    expect(d.asientosQueReparten).toBe(3);
    expect(d.precioBaseCents).toBe(800);
    expect(d.tarifaTotalCents).toBe(2400); // 800 × 3
    expect(d.driver).toEqual({ id: DRIVER_ID, name: 'José R', averageRating: 4.9 });
    expect(d.vehicle).toEqual({ make: 'Toyota', model: 'Yaris', color: 'Gris', plate: 'ABC-123' });
    expect(d.stopovers).toEqual([{ lat: -12.05, lon: -77.05, orden: 1 }]);
  });

  it('404 si la oferta no existe', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce(null);
    const service = makeService({ repo });
    await expect(service.getAdminCarpoolDetail('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('degradación HONESTA: identity + fleet caídos → driver.name/rating null + vehicle null, no se cuelga', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce(
      makeDetailRow({
        estado: PublishedTripState.EN_RUTA,
        originH3: null,
        destH3: null,
        stopovers: [],
        asientosDisponibles: 0,
        precioBase: 1000,
      }),
    );
    const failingBatch: IdentityBatchClient = {
      getDriversByIds: async () => {
        throw new Error('identity down');
      },
    };
    const failingFleet = makeFleet([makeVehicle()], async () => {
      throw new Error('fleet down');
    });
    const service = makeService({ repo, identityBatch: failingBatch, fleet: failingFleet });

    const d = await service.getAdminCarpoolDetail('c1');

    expect(d.driver).toEqual({ id: DRIVER_ID, name: null, averageRating: null });
    expect(d.vehicle).toBeNull();
    expect(d.asientosReservados).toBe(4); // 4 − 0
    expect(d.tarifaTotalCents).toBe(4000); // 1000 × 4
  });
});

describe('PublishedTripsService · GET /mine (scoped server-truth + paginado FIX 5)', () => {
  it('lista por driverId server-truth con default de página (limit 20, sin cursor)', async () => {
    const { repo, findByDriverId } = makeRepo();
    (findByDriverId as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 't1', driverId: DRIVER_ID },
    ]);
    const service = makeService({ repo });

    const result = await service.listMine(DRIVER_ID);

    expect(findByDriverId).toHaveBeenCalledWith(DRIVER_ID, 20, undefined);
    expect(result).toEqual([{ id: 't1', driverId: DRIVER_ID }]);
  });

  it('respeta limit y cursor del query (keyset)', async () => {
    const { repo, findByDriverId } = makeRepo();
    (findByDriverId as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const service = makeService({ repo });

    await service.listMine(DRIVER_ID, { limit: 5, cursor: 't10' });

    expect(findByDriverId).toHaveBeenCalledWith(DRIVER_ID, 5, 't10');
  });
});

describe('PublishedTripsService · getById (F0, intacto)', () => {
  it('devuelve la oferta; 404 tipado si no existe', async () => {
    const { repo, findById } = makeRepo();
    const service = makeService({ repo });

    findById.mockResolvedValueOnce({ id: 'x', estado: PublishedTripState.PUBLICADO });
    await expect(service.getById('x')).resolves.toMatchObject({ id: 'x' });

    findById.mockResolvedValueOnce(null);
    await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('PublishedTripsService · gate F1b (tope cost-sharing) cableado en publish + edit', () => {
  it('publish llama assertPriceCap con el estado a publicar (pais=PE, precioBase, tramos)', async () => {
    const { repo } = makeRepo();
    const { costCap, assertPriceCap } = makeCostCap();
    const service = makeService({ repo, costCap });

    await service.publish(DRIVER_ID, makeDto({ precioBase: 4500, asientosTotales: 3 }));

    expect(assertPriceCap).toHaveBeenCalledOnce();
    const input = assertPriceCap.mock.calls[0]![0] as PriceCapInput;
    expect(input.pais).toBe('PE');
    expect(input.precioBaseCentimos).toBe(4500);
    expect(input.asientosTotales).toBe(3);
    // sin tramos explícitos → full-route default [0→1] con precioBase (espeja resolvePrecioPorTramo).
    expect(input.tramos).toEqual([{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 4500 }]);
  });

  it('publish: si assertPriceCap rechaza (precio > tope) → NO publica (no escribe)', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const { costCap } = makeCostCap(async () => {
      throw new ValidationError('El precio base excede el tope de cost-sharing por distancia', {
        topeCentimos: 250,
      });
    });
    const service = makeService({ repo, costCap });

    await expect(
      service.publish(DRIVER_ID, makeDto({ precioBase: 999_999 })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createWithEventIdempotent).not.toHaveBeenCalled(); // gate ANTES de la escritura
  });

  it('publish: fail-closed si maps cae (ExternalServiceError) → NO publica', async () => {
    const { repo, createWithEventIdempotent } = makeRepo();
    const { costCap } = makeCostCap(async () => {
      throw new ExternalServiceError('No pudimos calcular la distancia de la ruta', {});
    });
    const service = makeService({ repo, costCap });

    await expect(service.publish(DRIVER_ID, makeDto())).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    expect(createWithEventIdempotent).not.toHaveBeenCalled();
  });

  it('EDIT a precioBase > tope → rechaza (re-valida el tope sobre el estado final), NO escribe', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
      pais: 'PE',
      asientosTotales: 4,
      precioBase: 4000,
      origenLat: -12.05,
      origenLon: -77.04,
      destinoLat: -12.1,
      destinoLon: -77.0,
      stopovers: [],
      precioPorTramo: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 4000 }],
    });
    const { costCap, assertPriceCap } = makeCostCap(async () => {
      throw new ValidationError('El precio base excede el tope de cost-sharing por distancia', {
        topeCentimos: 250,
      });
    });
    const service = makeService({ repo, costCap });

    await expect(service.update('x', DRIVER_ID, { precioBase: 999_999 })).rejects.toBeInstanceOf(
      ValidationError,
    );

    // re-validó con el precioBase EDITADO sobre el estado final (merge DTO ∪ persistido).
    const input = assertPriceCap.mock.calls[0]![0] as PriceCapInput;
    expect(input.precioBaseCentimos).toBe(999_999);
    expect(input.pais).toBe('PE');
    expect(updateWithEvent).not.toHaveBeenCalled(); // gate ANTES del write atómico
  });

  it('FIX 2 — EDIT que sube asientosTotales (precioBase fijo, ahora excede el tope nuevo) → re-valida y RECHAZA', async () => {
    // El tope = floor((distKm × c/km) / asientos): MÁS asientos = tope MENOR. Subir asientos con precioBase
    // fijo puede dejar el precio por encima del tope nuevo. ANTES editTouchesPriceCap NO miraba asientosTotales
    // → BYPASS. Ahora SÍ dispara la re-validación y el cap rechaza.
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
      pais: 'PE',
      asientosTotales: 2,
      precioBase: 4000,
      origenLat: -12.05,
      origenLon: -77.04,
      destinoLat: -12.1,
      destinoLon: -77.0,
      stopovers: [],
      precioPorTramo: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 4000 }],
    });
    const { costCap, assertPriceCap } = makeCostCap(async () => {
      throw new ValidationError('El precio base excede el tope de cost-sharing por distancia', {
        topeCentimos: 250,
      });
    });
    const service = makeService({ repo, costCap });

    // Solo se edita asientosTotales (de 2 → 8): tope nuevo más chico, precioBase persistido (4000) lo excede.
    await expect(service.update('x', DRIVER_ID, { asientosTotales: 8 })).rejects.toBeInstanceOf(
      ValidationError,
    );

    // Se re-validó: el merge usó asientosTotales EDITADO (8) y el precioBase PERSISTIDO (4000).
    expect(assertPriceCap).toHaveBeenCalledOnce();
    const input = assertPriceCap.mock.calls[0]![0] as PriceCapInput;
    expect(input.asientosTotales).toBe(8);
    expect(input.precioBaseCentimos).toBe(4000);
    expect(updateWithEvent).not.toHaveBeenCalled(); // gate ANTES del write
  });

  it('FIX 2 — EDIT que sube asientosTotales pero el tope sigue OK → re-valida y PERMITE el edit', async () => {
    const { repo, findByIdFromPrimary, updateWithEvent } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
      pais: 'PE',
      asientosTotales: 2,
      precioBase: 100,
      origenLat: -12.05,
      origenLon: -77.04,
      destinoLat: -12.1,
      destinoLon: -77.0,
      stopovers: [],
      precioPorTramo: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 100 }],
    });
    const { costCap, assertPriceCap } = makeCostCap(); // pasa
    const service = makeService({ repo, costCap });

    await service.update('x', DRIVER_ID, { asientosTotales: 4 });

    expect(assertPriceCap).toHaveBeenCalledOnce(); // asientosTotales DISPARA la re-validación
    expect(updateWithEvent).toHaveBeenCalledOnce();
  });

  it('EDIT que NO toca precio/ruta (solo reglas) → NO re-valida el tope (no pega a maps)', async () => {
    const { repo, findByIdFromPrimary } = makeRepo();
    findByIdFromPrimary.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      estado: PublishedTripState.PUBLICADO,
      pais: 'PE',
    });
    const { costCap, assertPriceCap } = makeCostCap();
    const service = makeService({ repo, costCap });

    await service.update('x', DRIVER_ID, { reglas: 'Sin mascotas' });

    expect(assertPriceCap).not.toHaveBeenCalled(); // ruta/precios sin cambios → no re-valida
  });
});

// ── F2 — BÚSQUEDA geo (H3 AND + filtros + orden + paginación + enriquecimiento anti-N+1) ───────────

// Coordenadas conocidas para las celdas H3 (res 9). Origen ~Lima centro, destino ~Miraflores.
const SEARCH_ORIGIN = { lat: -12.05, lon: -77.04 };
const SEARCH_DEST = { lat: -12.12, lon: -77.03 };
// FIX 2·F2: `fecha` es una fecha-calendario PURA `YYYY-MM-DD` (el DTO rechaza datetime/offset). Día futuro
// fijo para no chocar con el filtro `> now()` del repo (lejos en el calendario, no un instante "+1 día").
const TOMORROW_ISO = '2099-01-01';

function makeSearchDto(over: Partial<SearchPublishedTripsDto> = {}): SearchPublishedTripsDto {
  return {
    originLat: SEARCH_ORIGIN.lat,
    originLon: SEARCH_ORIGIN.lon,
    destLat: SEARCH_DEST.lat,
    destLon: SEARCH_DEST.lon,
    fecha: TOMORROW_ISO,
    asientos: 1,
    ...over,
  };
}

/** Fila PublishedTrip mínima para los resultados de búsqueda (solo los campos que el enriquecimiento toca). */
function makeTripRow(over: Partial<{ id: string; driverId: string; fechaHoraSalida: Date }> = {}) {
  return {
    id: over.id ?? 't1',
    driverId: over.driverId ?? DRIVER_ID,
    vehicleId: VEHICLE_ID,
    fechaHoraSalida: over.fechaHoraSalida ?? new Date(Date.now() + 90_000_000),
    estado: PublishedTripState.PUBLICADO,
  };
}

describe('PublishedTripsService · BÚSQUEDA (F2 · H3 ring AND + filtros + orden)', () => {
  it('arma el criterio: originRing/destRing = neighbors(toH3(extremo),k=1), AND (ruta A→B), asientos, SEARCHABLE_STATES, día + futuro', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([makeTripRow()]);
    const service = makeService({ repo });

    await service.search(makeSearchDto({ asientos: 2 }));

    expect(searchByRoute).toHaveBeenCalledOnce();
    const criteria = (searchByRoute as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // RUTA A→B: el ring del ORIGEN sale del origen buscado; el del DESTINO, del destino (no se cruzan).
    expect(criteria.originRing).toEqual(neighbors(toH3(SEARCH_ORIGIN, DISPATCH_H3_RESOLUTION), 1));
    expect(criteria.destRing).toEqual(neighbors(toH3(SEARCH_DEST, DISPATCH_H3_RESOLUTION), 1));
    expect(criteria.asientos).toBe(2);
    // estados elegibles: PUBLICADO + PARCIALMENTE_RESERVADO (no LLENO/CANCELADO/pasados).
    expect(criteria.estados).toEqual([
      PublishedTripState.PUBLICADO,
      PublishedTripState.PARCIALMENTE_RESERVADO,
    ]);
    // rango del DÍA pedido (desde 00:00 UTC, hasta +1 día) + ahora (filtro > now()).
    expect(criteria.hasta.getTime() - criteria.desde.getTime()).toBe(86_400_000);
    expect(criteria.ahora).toBeInstanceOf(Date);
    expect(criteria.take).toBe(20); // default
  });

  it('EXPANSIÓN k=1→k=2: si la base da 0 resultados, reintenta UNA vez con el anillo expandido', async () => {
    const { repo, searchByRoute } = makeRepo();
    const spy = searchByRoute as ReturnType<typeof vi.fn>;
    spy.mockResolvedValueOnce([]); // k=1 vacío
    spy.mockResolvedValueOnce([makeTripRow()]); // k=2 encuentra
    const service = makeService({ repo });

    const page = await service.search(makeSearchDto());

    expect(spy).toHaveBeenCalledTimes(2);
    // 1ª llamada con k=1, 2ª con k=2 (anillo más grande).
    expect(spy.mock.calls[0]![0].originRing).toEqual(
      neighbors(toH3(SEARCH_ORIGIN, DISPATCH_H3_RESOLUTION), 1),
    );
    expect(spy.mock.calls[1]![0].originRing).toEqual(
      neighbors(toH3(SEARCH_ORIGIN, DISPATCH_H3_RESOLUTION), 2),
    );
    expect(page.items).toHaveLength(1);
  });

  it('NO expande si la base YA trajo resultados (una sola pasada)', async () => {
    const { repo, searchByRoute } = makeRepo();
    const spy = searchByRoute as ReturnType<typeof vi.fn>;
    spy.mockResolvedValueOnce([makeTripRow()]); // k=1 ya encontró
    const service = makeService({ repo });

    await service.search(makeSearchDto());

    expect(spy).toHaveBeenCalledTimes(1); // no reintentó
  });

  it('NO expande en páginas de continuación (con cursor): el radio lo fija la primera página', async () => {
    const { repo, searchByRoute } = makeRepo();
    const spy = searchByRoute as ReturnType<typeof vi.fn>;
    spy.mockResolvedValueOnce([]); // vacío, pero hay cursor → no expande
    const service = makeService({ repo });

    // cursor opaco válido (lo genera el service; acá uno bien formado).
    const cursor = Buffer.from(`${TOMORROW_ISO}|t9`, 'utf8').toString('base64url');
    await service.search(makeSearchDto({ cursor }));

    expect(spy).toHaveBeenCalledTimes(1); // con cursor NO expande
    expect(spy.mock.calls[0]![0].cursor).toMatchObject({ id: 't9' });
  });

  it('respeta limit del DTO (acotado por @Max(50) en el borde)', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const service = makeService({ repo });

    await service.search(makeSearchDto({ limit: 10 }));

    expect((searchByRoute as ReturnType<typeof vi.fn>).mock.calls[0]![0].take).toBe(10);
  });

  it('nextCursor: null si la página vino corta (< take); presente si vino llena (== take)', async () => {
    const { repo, searchByRoute } = makeRepo();
    const spy = searchByRoute as ReturnType<typeof vi.fn>;
    const service = makeService({ repo });

    // página corta → no hay más → nextCursor null.
    spy.mockResolvedValueOnce([makeTripRow({ id: 't1' })]);
    const short = await service.search(makeSearchDto({ limit: 5 }));
    expect(short.nextCursor).toBeNull();

    // página llena (== take=1) → nextCursor codifica la última fila.
    spy.mockResolvedValueOnce([makeTripRow({ id: 't2' })]);
    const full = await service.search(makeSearchDto({ limit: 1 }));
    expect(full.nextCursor).toBeTypeOf('string');
  });

  it('rechaza fecha inválida (ValidationError), no pega al repo', async () => {
    const { repo, searchByRoute } = makeRepo();
    const service = makeService({ repo });
    await expect(service.search(makeSearchDto({ fecha: 'no-es-fecha' }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(searchByRoute).not.toHaveBeenCalled();
  });
});

describe('PublishedTripsService · BÚSQUEDA · radio EDITABLE EN RUNTIME (config del admin, F2)', () => {
  it('usa el k VIGENTE del reader (no un env estático): un radio admin k=3/k=4 arma neighbors(centro, 3) y expande a 4', async () => {
    const { repo, searchByRoute } = makeRepo();
    const spy = searchByRoute as ReturnType<typeof vi.fn>;
    spy.mockResolvedValueOnce([]); // base k=3 vacío → expande
    spy.mockResolvedValueOnce([makeTripRow()]); // expand k=4 encuentra
    // El admin subió el radio (config): base=3, expand=4. El service DEBE leerlo en runtime.
    const service = makeService({ repo, searchConfig: { kRing: 3, kRingExpand: 4 } });

    await service.search(makeSearchDto());

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0].originRing).toEqual(
      neighbors(toH3(SEARCH_ORIGIN, DISPATCH_H3_RESOLUTION), 3),
    );
    expect(spy.mock.calls[1]![0].originRing).toEqual(
      neighbors(toH3(SEARCH_ORIGIN, DISPATCH_H3_RESOLUTION), 4),
    );
  });

  it('un cambio del reader entre búsquedas se HONRA sin reconstruir el service (admin edita en caliente)', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValue([makeTripRow()]);
    // Reader mutable: emula el PUT del admin que invalida el cache → la siguiente búsqueda ve el k nuevo.
    let kRing = 1;
    const mutableReader: SearchRadiusReader = {
      getKRings: async () => ({ kRing, kRingExpand: kRing + 1 }),
      getResolvedRadii: async () => ({
        baseRadiusKm: kRing * 0.3,
        expandRadiusKm: (kRing + 1) * 0.3,
        baseKRing: kRing,
        expandKRing: kRing + 1,
      }),
    };
    const service = makeService({ repo, searchReader: mutableReader });

    await service.search(makeSearchDto());
    const firstK = (searchByRoute as ReturnType<typeof vi.fn>).mock.calls[0]![0].originRing;
    expect(firstK).toEqual(neighbors(toH3(SEARCH_ORIGIN, DISPATCH_H3_RESOLUTION), 1));

    kRing = 5; // el admin editó el radio en caliente
    await service.search(makeSearchDto());
    const secondK = (searchByRoute as ReturnType<typeof vi.fn>).mock.calls[1]![0].originRing;
    expect(secondK).toEqual(neighbors(toH3(SEARCH_ORIGIN, DISPATCH_H3_RESOLUTION), 5));
  });
});

describe('PublishedTripsService · RADAR PREVIEW (F2 · densidad real por radio)', () => {
  const CENTER = { lat: -12.05, lon: -77.04 };

  it('cuenta ofertas disponibles por radio base/expand (reusa el índice H3) y arma la vista', async () => {
    const { repo, countAvailableByOriginRing } = makeRepo();
    const spy = countAvailableByOriginRing as ReturnType<typeof vi.fn>;
    spy.mockResolvedValueOnce(2); // dentro del radio base (k=1)
    spy.mockResolvedValueOnce(7); // dentro del radio expand (k=2)
    const service = makeService({ repo }); // reader default k=1/k=2 → km 0.3/0.6

    const preview = await service.radarPreview(CENTER.lat, CENTER.lon);

    expect(preview.center).toEqual(CENTER);
    expect(preview.rings).toEqual([
      { radiusKm: 0.3, kRing: 1, count: 2 },
      { radiusKm: 0.6, kRing: 2, count: 7 },
    ]);
    // totalInRange = dentro del radio MAYOR (el expandido).
    expect(preview.totalInRange).toBe(7);
    // Cada anillo consultó neighbors(centro, k) — reusa el mismo índice H3, sin estructura nueva.
    expect(spy.mock.calls[0]![0]).toEqual(
      neighbors(toH3(CENTER, DISPATCH_H3_RESOLUTION), 1),
    );
    expect(spy.mock.calls[1]![0]).toEqual(
      neighbors(toH3(CENTER, DISPATCH_H3_RESOLUTION), 2),
    );
  });

  it('devuelve la MUESTRA de orígenes reales (lat/lon) del radio expandido para plotear en el mapa', async () => {
    const { repo, sampleAvailableOriginsByRing } = makeRepo();
    const spy = sampleAvailableOriginsByRing as ReturnType<typeof vi.fn>;
    const origins = [
      { lat: -12.05, lon: -77.04 },
      { lat: -12.06, lon: -77.05 },
    ];
    spy.mockResolvedValue(origins);
    const service = makeService({ repo }); // reader default k=1/k=2

    const preview = await service.radarPreview(CENTER.lat, CENTER.lon);

    expect(preview.drivers).toEqual(origins);
    // Se muestrea el anillo MÁS ANCHO (el expandido, k=2) y con el tope de 100.
    expect(spy.mock.calls[0]![0]).toEqual(neighbors(toH3(CENTER, DISPATCH_H3_RESOLUTION), 2));
    expect(spy.mock.calls[0]![3]).toBe(100);
  });

  it('0 honesto cuando no hay ofertas alrededor (no inventa densidad ni posiciones)', async () => {
    const { repo, countAvailableByOriginRing } = makeRepo();
    (countAvailableByOriginRing as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const service = makeService({ repo });

    const preview = await service.radarPreview(CENTER.lat, CENTER.lon);

    expect(preview.totalInRange).toBe(0);
    expect(preview.rings.every((r) => r.count === 0)).toBe(true);
    expect(preview.drivers).toEqual([]);
  });
});

describe('PublishedTripsService · BÚSQUEDA · enriquecimiento ANTI-N+1', () => {
  it('UNA sola GetDriversByIds para N viajes (driverIds únicos), mapea cada viaje con su conductor público', async () => {
    const { repo, searchByRoute } = makeRepo();
    const dA = '00000000-0000-0000-0000-0000000000a1';
    const dB = '00000000-0000-0000-0000-0000000000b2';
    // 3 viajes, 2 conductores únicos (dA repetido).
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeTripRow({ id: 't1', driverId: dA }),
      makeTripRow({ id: 't2', driverId: dB }),
      makeTripRow({ id: 't3', driverId: dA }),
    ]);
    const { client, getDriversByIds } = makeIdentityBatch();
    const service = makeService({ repo, identityBatch: client });

    const page = await service.search(makeSearchDto());

    // ANTI-N+1: UNA invocación batch (no 3 GetDriver), con los driverIds ÚNICOS.
    expect(getDriversByIds).toHaveBeenCalledOnce();
    const idsArg = getDriversByIds.mock.calls[0]![0] as string[];
    expect([...idsArg].sort()).toEqual([dA, dB].sort());
    // cada viaje quedó mapeado con su conductor.
    expect(page.items.map((i) => i.driver?.id)).toEqual([dA, dB, dA]);
  });

  it('SEARCH best-effort: si identity (batch) cae, la oferta VIAJA con driver degradado (null), no vacía la página', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([makeTripRow({ id: 't1' })]);
    const { client } = makeIdentityBatch(async () => {
      throw new Error('identity caída');
    });
    const service = makeService({ repo, identityBatch: client });

    const page = await service.search(makeSearchDto());

    // BEST-EFFORT (display, no compromiso de dinero): identity caída = NO-VERIFICABLE → no filtramos por conductor
    // y la card viaja con driver null (degradación honesta). El gate de dinero es la reserva (re-valida elegibilidad
    // fail-closed). Mejor un browse vivo con cards degradadas que apagar el catálogo entero por un blip de identity.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.driver).toBeNull();
  });

  it('no llama al batch si no hubo resultados (lista vacía)', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValue([]); // ambas pasadas vacías
    const { client, getDriversByIds } = makeIdentityBatch();
    const service = makeService({ repo, identityBatch: client });

    const page = await service.search(makeSearchDto());

    expect(page.items).toHaveLength(0);
    expect(getDriversByIds).not.toHaveBeenCalled();
  });
});

describe('PublishedTripsService · DETALLE enriquecido (F2 · conductor + vehículo público)', () => {
  it('enriquece con conductor (name/rating) + vehículo (modelo/placa), solo campos públicos', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'trip-1',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.PUBLICADO,
      fechaHoraSalida: new Date(Date.now() + 90_000_000), // futura (FIX 4)
    });
    const identity = makeIdentity(makeDriver({ name: 'Ana Pérez', averageRating: 4.9 }));
    const fleet = makeFleet(
      [makeVehicle()],
      makeVehicleView({ model: 'Corolla', plate: 'XYZ-789' }),
    );
    const service = makeService({ repo, identity, fleet });

    const detail = await service.getDetail('trip-1');

    expect(detail.trip.id).toBe('trip-1');
    expect(detail.driver).toEqual({ id: DRIVER_ID, name: 'Ana Pérez', averageRating: 4.9 });
    expect(detail.vehicle?.model).toBe('Corolla');
    expect(detail.vehicle?.plate).toBe('XYZ-789');
  });

  it('404 tipado si el viaje no existe (no llama a identity/fleet)', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce(null);
    const service = makeService({ repo });
    await expect(service.getDetail('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('FIX 3 fail-closed: identity CAÍDA (transporte) → 502 reintentable (ExternalServiceError), no 404 "no existe"', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'trip-2',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.PUBLICADO,
      fechaHoraSalida: new Date(Date.now() + 90_000_000),
    });
    const identity = makeIdentity(async () => {
      throw new Error('identity caída');
    });
    const service = makeService({ repo, identity });
    // Elegibilidad es un GATE de seguridad: si no podemos verificarla, NO ofrecemos el viaje. PERO un fallo de
    // TRANSPORTE (identity caída) es transitorio → 502 reintentable, MISMA semántica que la reserva, no 404
    // "viaje inexistente" (que le diría al pasajero que abandone). Verificado-malo (no elegible) sí es 404 (otro test).
    await expect(service.getDetail('trip-2')).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('Lote 3 fail-closed: fleet CAÍDA (transporte) → 502 reintentable (ExternalServiceError), no 404 "no existe"', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'trip-3',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.PUBLICADO,
      fechaHoraSalida: new Date(Date.now() + 90_000_000),
    });
    const fleet = makeFleet([], async () => {
      throw new Error('fleet caída');
    });
    const service = makeService({ repo, fleet }); // identity elegible por default
    // La operabilidad del vehículo es un GATE de seguridad/legal (SOAT+ITV): si no podemos verificarla, NO
    // ofrecemos el viaje. PERO fleet CAÍDA es transporte transitorio → 502 reintentable (misma semántica que la
    // reserva, coherencia passenger-facing), no 404 definitivo. Verificado-malo (no operable) sí es 404 (otro test).
    await expect(service.getDetail('trip-3')).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it.each([
    ['no encontrado en fleet', { found: false }],
    ['inactivo', { active: false }],
    ['revisión pendiente (status)', { status: 'PENDING_REVIEW' }],
    ['docs vencidos (docStatus)', { docStatus: FleetDocumentStatus.EXPIRED }],
  ])(
    'Lote 3 gate de operabilidad: vehículo %s → 404 (oferta no ofertable, aunque el conductor sea elegible)',
    async (_caso, over) => {
      const { repo, findById } = makeRepo();
      findById.mockResolvedValueOnce({
        id: 'trip-op',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        estado: PublishedTripState.PUBLICADO,
        fechaHoraSalida: new Date(Date.now() + 90_000_000),
      });
      const fleet = makeFleet([], makeVehicleView(over));
      const service = makeService({ repo, fleet }); // identity elegible por default
      await expect(service.getDetail('trip-op')).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  it('Lote 3: vehículo OPERABLE → detalle se devuelve con la cara pública del vehículo (display)', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'trip-ok',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.PUBLICADO,
      fechaHoraSalida: new Date(Date.now() + 90_000_000),
    });
    const fleet = makeFleet([], makeVehicleView({ model: 'Corolla', plate: 'XYZ-789' }));
    const service = makeService({ repo, fleet });
    const detail = await service.getDetail('trip-ok');
    expect(detail.driver).not.toBeNull();
    expect(detail.vehicle?.model).toBe('Corolla');
    expect(detail.vehicle?.plate).toBe('XYZ-789');
    expect(detail.vehicle?.found).toBe(true);
  });
});

// ── F2 — FIX 1: la VISTA PÚBLICA NUNCA expone dedupKey ni internos (minimización H8) ─────────────────
describe('PublishedTripsService · FIX 1 · view PÚBLICO sin dedupKey/internos (search + detalle)', () => {
  /** Fila CRUDA con TODOS los internos que NO deben salir por el wire. */
  function makeRawTrip(over: Record<string, unknown> = {}) {
    return {
      id: 't-pub',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      dedupKey: 'published:req:secret-internal-key',
      originH3: '8928308280fffff',
      destH3: '8928308281fffff',
      origenLat: -12.05,
      origenLon: -77.04,
      destinoLat: -12.12,
      destinoLon: -77.03,
      stopovers: [],
      fechaHoraSalida: new Date(Date.now() + 90_000_000),
      asientosTotales: 3,
      asientosDisponibles: 2,
      pricingMode: PricingMode.FIJO,
      precioBase: 4500,
      precioPorTramo: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 4500 }],
      modoReserva: ModoReserva.REVISION_CADA_SOLICITUD,
      reglas: null,
      pais: 'PE',
      moneda: 'PEN',
      estado: PublishedTripState.PUBLICADO,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
  }

  it('SEARCH: el trip del item NO contiene dedupKey/driverId/vehicleId/originH3/destH3', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([makeRawTrip()]);
    const service = makeService({ repo });

    const page = await service.search(makeSearchDto());

    expect(page.items).toHaveLength(1);
    const trip = page.items[0]!.trip as unknown as Record<string, unknown>;
    expect(trip).not.toHaveProperty('dedupKey');
    expect(trip).not.toHaveProperty('driverId');
    expect(trip).not.toHaveProperty('vehicleId');
    expect(trip).not.toHaveProperty('originH3');
    expect(trip).not.toHaveProperty('destH3');
    expect(trip).not.toHaveProperty('createdAt');
    // sí están los campos públicos que la UI usa:
    expect(trip.id).toBe('t-pub');
    expect(trip.precioBase).toBe(4500);
    expect(trip.asientosDisponibles).toBe(2);
  });

  it('SEARCH: el driver del item es display-only (id/name/averageRating), SIN ejes de elegibilidad', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([makeRawTrip()]);
    const service = makeService({ repo });

    const page = await service.search(makeSearchDto());
    const driver = page.items[0]!.driver as unknown as Record<string, unknown>;
    expect(Object.keys(driver).sort()).toEqual(['averageRating', 'id', 'name']);
    expect(driver).not.toHaveProperty('kycStatus');
    expect(driver).not.toHaveProperty('suspendedAt');
    expect(driver).not.toHaveProperty('currentStatus');
  });

  it('SEARCH Lote 3b: oferta con vehículo NO operable (docs vencidos) → se DESCARTA de la página', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([makeRawTrip()]);
    // fleet responde, pero el vehículo de la oferta tiene docs VENCIDOS → no operable → la card no se muestra.
    const fleet = makeFleet(
      [],
      makeVehicleView(),
      new Map([[VEHICLE_ID, makeVehicleView({ docStatus: FleetDocumentStatus.EXPIRED })]]),
    );
    const service = makeService({ repo, fleet }); // conductor elegible por default

    const page = await service.search(makeSearchDto());
    // El conductor es elegible, pero el vehículo no opera → la oferta NO aparece en la búsqueda.
    expect(page.items).toHaveLength(0);
  });

  it('SEARCH Lote 3b best-effort: fleet CAÍDA → la oferta igual se devuelve (no filtra por vehículo; gate real es detalle/reserva)', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([makeRawTrip()]);
    // fleet no responde para el filtro batch = NO-VERIFICABLE → no filtramos por vehículo (degradación honesta). El
    // conductor sí se verificó OK, así que la oferta viaja; el dinero lo gatea el detalle (404) / reserva (409/502),
    // ambos fail-closed. La búsqueda solo MUESTRA: una card no-reservable es un papercut de UX, no un hueco de plata.
    const fleet = makeFleet([], makeVehicleView(), async () => {
      throw new Error('fleet caída');
    });
    const service = makeService({ repo, fleet });

    const page = await service.search(makeSearchDto());
    expect(page.items).toHaveLength(1);
  });

  it('DETALLE: el trip NO contiene dedupKey/driverId/vehicleId/originH3/destH3', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce(makeRawTrip());
    const fleet = makeFleet([makeVehicle()], makeVehicleView());
    const service = makeService({ repo, fleet });

    const detail = await service.getDetail('t-pub');
    const trip = detail.trip as unknown as Record<string, unknown>;
    expect(trip).not.toHaveProperty('dedupKey');
    expect(trip).not.toHaveProperty('driverId');
    expect(trip).not.toHaveProperty('vehicleId');
    expect(trip).not.toHaveProperty('originH3');
    expect(trip).not.toHaveProperty('destH3');
    expect(trip.id).toBe('t-pub');
  });
});

// ── F2 — FIX 2: ventana del día en HORA PERÚ (UTC-5), no UTC ──────────────────────────────────────────
describe('PublishedTripsService · FIX 2 · ventana del día en hora Lima (UTC-5)', () => {
  it('un viaje 23:00 hora Lima del día X cae DENTRO del rango [desde, hasta) del día X buscado', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const service = makeService({ repo });

    // Pasajero busca el día 2030-03-15 (fecha futura para no chocar con > now()).
    await service.search(makeSearchDto({ fecha: '2030-03-15' }));

    const c = (searchByRoute as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // 23:00 hora Lima del 2030-03-15 == 04:00 UTC del 2030-03-16. Debe caer en [desde, hasta).
    const viaje2300Lima = new Date('2030-03-16T04:00:00.000Z');
    expect(viaje2300Lima.getTime()).toBeGreaterThanOrEqual(c.desde.getTime());
    expect(viaje2300Lima.getTime()).toBeLessThan(c.hasta.getTime());
    // 00:00 Lima del 2030-03-15 == 05:00 UTC del mismo día (UTC-5).
    expect(c.desde.toISOString()).toBe('2030-03-15T05:00:00.000Z');
    expect(c.hasta.toISOString()).toBe('2030-03-16T05:00:00.000Z');
    expect(c.hasta.getTime() - c.desde.getTime()).toBe(86_400_000);
  });

  it('un viaje 00:30 hora Lima del día X NO cae en el rango del día X-1 (no se cuela el del día equivocado)', async () => {
    const { repo, searchByRoute } = makeRepo();
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const service = makeService({ repo });

    await service.search(makeSearchDto({ fecha: '2030-03-14' })); // busca el día ANTERIOR
    const c = (searchByRoute as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // 00:30 Lima del 2030-03-15 == 05:30 UTC del 2030-03-15. NO debe estar en el rango del día 14.
    const viaje0030LimaDia15 = new Date('2030-03-15T05:30:00.000Z');
    expect(viaje0030LimaDia15.getTime()).toBeGreaterThanOrEqual(c.hasta.getTime()); // fuera (>= hasta)
  });
});

// ── F2 — FIX 3: ofertas de conductores NO elegibles NO aparecen (search + detalle) ──────────────────
describe('PublishedTripsService · FIX 3 · filtro de elegibilidad del conductor (search)', () => {
  it('SEARCH: una oferta de un conductor SUSPENDIDO (suspendedAt) NO aparece en los resultados', async () => {
    const { repo, searchByRoute } = makeRepo();
    const dOk = '00000000-0000-0000-0000-0000000000a1';
    const dSusp = '00000000-0000-0000-0000-0000000000b2';
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeTripRow({ id: 't1', driverId: dOk }),
      makeTripRow({ id: 't2', driverId: dSusp }),
    ]);
    const { client } = makeIdentityBatch(async (ids) =>
      ids.map((id) =>
        id === dSusp
          ? makePublicDriver(id, { suspendedAt: new Date().toISOString() })
          : makePublicDriver(id),
      ),
    );
    const service = makeService({ repo, identityBatch: client });

    const page = await service.search(makeSearchDto());
    // Solo el viaje del conductor elegible sobrevive; el del suspendido se descarta.
    expect(page.items.map((i) => i.trip.id)).toEqual(['t1']);
  });

  it('SEARCH: oferta de conductor con currentStatus SUSPENDED o KYC no VERIFIED NO aparece', async () => {
    const { repo, searchByRoute } = makeRepo();
    const dOk = '00000000-0000-0000-0000-0000000000a1';
    const dStatus = '00000000-0000-0000-0000-0000000000b2';
    const dKyc = '00000000-0000-0000-0000-0000000000c3';
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeTripRow({ id: 't1', driverId: dOk }),
      makeTripRow({ id: 't2', driverId: dStatus }),
      makeTripRow({ id: 't3', driverId: dKyc }),
    ]);
    const { client } = makeIdentityBatch(async (ids) =>
      ids.map((id) => {
        if (id === dStatus) return makePublicDriver(id, { currentStatus: DriverStatus.SUSPENDED });
        if (id === dKyc) return makePublicDriver(id, { kycStatus: KycStatus.PENDING });
        return makePublicDriver(id);
      }),
    );
    const service = makeService({ repo, identityBatch: client });

    const page = await service.search(makeSearchDto());
    expect(page.items.map((i) => i.trip.id)).toEqual(['t1']);
  });

  it('SEARCH: conductor ausente del reply (found=false implícito) → su oferta NO aparece', async () => {
    const { repo, searchByRoute } = makeRepo();
    const dOk = '00000000-0000-0000-0000-0000000000a1';
    const dGone = '00000000-0000-0000-0000-0000000000b2';
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeTripRow({ id: 't1', driverId: dOk }),
      makeTripRow({ id: 't2', driverId: dGone }),
    ]);
    // El batch solo devuelve al conductor OK; el otro no viene → no resoluble → no se muestra.
    const { client } = makeIdentityBatch(async (ids) =>
      ids.filter((id) => id === dOk).map((id) => makePublicDriver(id)),
    );
    const service = makeService({ repo, identityBatch: client });

    const page = await service.search(makeSearchDto());
    expect(page.items.map((i) => i.trip.id)).toEqual(['t1']);
  });

  it('DETALLE: si el conductor del viaje fue SUSPENDIDO, el detalle NO lo ofrece → 404', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'trip-susp',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.PUBLICADO,
      fechaHoraSalida: new Date(Date.now() + 90_000_000),
    });
    const identity = makeIdentity(makeDriver({ suspendedAt: new Date().toISOString() }));
    const service = makeService({ repo, identity });
    await expect(service.getDetail('trip-susp')).rejects.toBeInstanceOf(NotFoundError);
  });

  // ── FIX 1·F2: PARIDAD publish↔search↔detail en ANTECEDENTES (backgroundCheck no-cleared) ──
  it('SEARCH: oferta de conductor con backgroundCheckStatus NO-cleared NO aparece (paridad con publish)', async () => {
    const { repo, searchByRoute } = makeRepo();
    const dOk = '00000000-0000-0000-0000-0000000000a1';
    const dBg = '00000000-0000-0000-0000-0000000000b2';
    (searchByRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeTripRow({ id: 't1', driverId: dOk }),
      makeTripRow({ id: 't2', driverId: dBg }),
    ]);
    const { client } = makeIdentityBatch(async (ids) =>
      ids.map((id) =>
        id === dBg
          ? makePublicDriver(id, { backgroundCheckStatus: 'PENDING' })
          : makePublicDriver(id),
      ),
    );
    const service = makeService({ repo, identityBatch: client });

    const page = await service.search(makeSearchDto());
    // El conductor con antecedentes no-cleared se filtra igual que en publish (ANTES pasaba el filtro de search).
    expect(page.items.map((i) => i.trip.id)).toEqual(['t1']);
  });

  it('DETALLE: conductor con backgroundCheckStatus NO-cleared → NO se ofrece → 404 (paridad con publish)', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'trip-bg',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.PUBLICADO,
      fechaHoraSalida: new Date(Date.now() + 90_000_000),
    });
    const identity = makeIdentity(makeDriver({ backgroundCheckStatus: 'REJECTED' }));
    const service = makeService({ repo, identity });
    await expect(service.getDetail('trip-bg')).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── F2 — FIX 4: el detalle filtra estado searchable + futuro ─────────────────────────────────────────
describe('PublishedTripsService · FIX 4 · detalle solo viajes searchable + futuros', () => {
  it('viaje CANCELADO → NotFoundError (no se ofrece, no filtra existencia)', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.CANCELADO,
      fechaHoraSalida: new Date(Date.now() + 90_000_000),
    });
    const service = makeService({ repo });
    await expect(service.getDetail('x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('viaje PASADO (fechaHoraSalida <= now) aunque PUBLICADO → NotFoundError', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.PUBLICADO,
      fechaHoraSalida: new Date(Date.now() - 1000), // ya partió
    });
    const service = makeService({ repo });
    await expect(service.getDetail('x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('viaje LLENO (no searchable) → NotFoundError', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.LLENO,
      fechaHoraSalida: new Date(Date.now() + 90_000_000),
    });
    const service = makeService({ repo });
    await expect(service.getDetail('x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('viaje PARCIALMENTE_RESERVADO + futuro + conductor elegible → se devuelve', async () => {
    const { repo, findById } = makeRepo();
    findById.mockResolvedValueOnce({
      id: 'x',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      estado: PublishedTripState.PARCIALMENTE_RESERVADO,
      fechaHoraSalida: new Date(Date.now() + 90_000_000),
    });
    const fleet = makeFleet([makeVehicle()], makeVehicleView());
    const service = makeService({ repo, fleet });
    const detail = await service.getDetail('x');
    expect(detail.trip.id).toBe('x');
    expect(detail.trip.estado).toBe(PublishedTripState.PARCIALMENTE_RESERVADO);
  });
});

/** Fila de carpool activo para el monitoreo (solo los campos que lee el mapeo del service). */
function makeActiveRow(
  over: Partial<{
    id: string;
    driverId: string;
    asientosTotales: number;
    asientosDisponibles: number;
    estado: PublishedTripState;
  }> = {},
) {
  return {
    id: over.id ?? 'c1',
    driverId: over.driverId ?? DRIVER_ID,
    vehicleId: VEHICLE_ID,
    origenLat: -12.1,
    origenLon: -77.0,
    destinoLat: -12.0,
    destinoLon: -77.1,
    fechaHoraSalida: new Date('2026-08-01T12:00:00Z'),
    asientosTotales: over.asientosTotales ?? 4,
    asientosDisponibles: over.asientosDisponibles ?? 1,
    estado: over.estado ?? PublishedTripState.PARCIALMENTE_RESERVADO,
  };
}

describe('PublishedTripsService · MONITOREO carpools activos (KPIs agregados + listado)', () => {
  it('computa ocupación PONDERADA (Σreservados/Σtotales), reservados=totales−disponibles, y enriquece nombre anti-N+1', async () => {
    const { repo, listActiveCarpools, aggregateActiveCarpools, countByState } = makeRepo();
    listActiveCarpools.mockResolvedValue([
      makeActiveRow({ id: 'c1', driverId: 'd1', asientosTotales: 4, asientosDisponibles: 1 }),
      makeActiveRow({
        id: 'c2',
        driverId: 'd2',
        asientosTotales: 3,
        asientosDisponibles: 3,
        estado: PublishedTripState.PUBLICADO,
      }),
    ]);
    // Agregado sobre el filtro COMPLETO (no la página): total real de activos + sumas de asientos.
    aggregateActiveCarpools.mockResolvedValue({
      count: 12,
      asientosTotales: 40,
      asientosDisponibles: 15,
    });
    countByState.mockResolvedValue(3);
    const { client, getDriversByIds } = makeIdentityBatch((ids) =>
      Promise.resolve(ids.map((id) => makePublicDriver(id, { name: `Nombre ${id}` }))),
    );
    const service = makeService({ repo, identityBatch: client });

    const res = await service.listActiveCarpools();

    expect(res.stats.activeCount).toBe(12);
    expect(res.stats.enRouteCount).toBe(3);
    expect(res.stats.seatsReserved).toBe(25); // 40 − 15
    expect(res.stats.seatsAvailable).toBe(15);
    expect(res.stats.avgOccupancyPct).toBe(63); // 25/40 = 62.5 → redondeo 63
    expect(res.carpools).toHaveLength(2);
    expect(res.carpools[0]).toMatchObject({
      id: 'c1',
      asientosReservados: 3, // 4 − 1
      driverName: 'Nombre d1',
      estado: PublishedTripState.PARCIALMENTE_RESERVADO,
    });
    expect(res.carpools[1]).toMatchObject({ id: 'c2', asientosReservados: 0, driverName: 'Nombre d2' });
    // Anti-N+1: UNA sola llamada batch para los N carpools.
    expect(getDriversByIds).toHaveBeenCalledOnce();
    expect(getDriversByIds.mock.calls[0]![0] as string[]).toEqual(['d1', 'd2']);
  });

  it('degradación HONESTA: identity caída → driverName null, el monitoreo NO se cuelga (KPIs igual)', async () => {
    const { repo, listActiveCarpools, aggregateActiveCarpools } = makeRepo();
    listActiveCarpools.mockResolvedValue([
      makeActiveRow({
        id: 'c1',
        asientosTotales: 4,
        asientosDisponibles: 0,
        estado: PublishedTripState.LLENO,
      }),
    ]);
    aggregateActiveCarpools.mockResolvedValue({
      count: 1,
      asientosTotales: 4,
      asientosDisponibles: 0,
    });
    const failing: IdentityBatchClient = {
      getDriversByIds: async () => {
        throw new Error('identity down');
      },
    };
    const service = makeService({ repo, identityBatch: failing });

    const res = await service.listActiveCarpools();

    expect(res.carpools[0]!.driverName).toBeNull();
    expect(res.carpools[0]!.asientosReservados).toBe(4);
    expect(res.stats.avgOccupancyPct).toBe(100); // 4/4
  });

  it('sin carpools activos: KPIs en 0 y listado vacío (0 honesto, no se inventa)', async () => {
    const { repo } = makeRepo(); // defaults: listado [], agregado count/sumas 0, countByState 0
    const service = makeService({ repo });

    const res = await service.listActiveCarpools();

    expect(res.carpools).toEqual([]);
    expect(res.stats).toEqual({
      activeCount: 0,
      enRouteCount: 0,
      seatsReserved: 0,
      seatsAvailable: 0,
      avgOccupancyPct: 0,
    });
  });
});
