import { describe, it, expect } from 'vitest';
import { NotFoundError } from '@veo/utils';
import type { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import type { GeocodeResult, MapsClient, RouteResult } from '@veo/maps';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import {
  isPujaMode,
  OFFERING_LIST,
  OFFERINGS,
  OfferingId,
  PricingMode,
  type OfferingSpec,
} from '@veo/shared-types';
import { MapsService } from './maps.service';
import { catalogDegradedTotal } from './maps-metrics';
import { categoryFareCents, DEFAULT_BID_FLOOR_CENTS } from './fare';
import type { Env } from '../config/env.schema';

/** Identidad de prueba del pasajero (la quote la firma para la lectura interna del modo). */
const USER: AuthenticatedUser = { userId: 'p1', type: 'passenger', roles: [], sessionId: 's1' };

/** ConfigService falso. El MapsService ya no lee env; se mantiene por compat de la firma del constructor. */
function fakeConfig(bidFloorCents = DEFAULT_BID_FLOOR_CENTS): ConfigService<Env, true> {
  return {
    getOrThrow: () => bidFloorCents,
  } as unknown as ConfigService<Env, true>;
}

/**
 * Doble del cliente REST interno hacia trip-service. Distingue endpoints:
 *  - `/internal/pricing/resolve` → devuelve `{ mode }` fijo (o lanza el Error, para probar la degradación)
 *    y registra la última query (lat/lon del origen).
 *  - `/internal/catalog` → devuelve el catálogo efectivo; `disabledIds` permite simular el overlay del
 *    admin (ofertas apagadas) para testear el filtrado del quote (B1c).
 */
class FakeTripRest {
  lastQuery?: Record<string, unknown>;
  constructor(
    private readonly result: { mode: 'PUJA' | 'FIXED' } | Error = { mode: 'FIXED' },
    private readonly disabledIds: readonly string[] = [],
    private readonly catalogError?: Error,
    // B2: override EFECTIVO por oferta (lo que trip-service ya resolvió: pricing + pin de modo).
    private readonly catalogOverrides: Partial<
      Record<OfferingId, { multiplier?: number; minFareCents?: number; modePin?: PricingMode }>
    > = {},
    // ADR 010 §9.3: config del piso de la PUJA que devuelve /internal/pricing/bid-floor (default + overrides
    // por oferta). Default = piso global S/7 sin overrides (= comportamiento previo de los specs).
    private readonly bidFloor: {
      defaultFloorCents: number;
      overrides: { zone: string; offeringId: string; floorCents: number }[];
    } = { defaultFloorCents: 700, overrides: [] },
    // Simula el endpoint del piso CAÍDO (degradación honesta: el quote cae a DEFAULT_BID_FLOOR_CONFIG).
    private readonly bidFloorError?: Error,
    // F2.4: tarifa base (banderazo/km/min) que devuelve /internal/pricing/base-fare. Default = las
    // constantes de código (= el seed) → el quote computa igual que antes de F2.4.
    private readonly baseFare: {
      baseFareCents: number;
      perKmCents: number;
      perMinCents: number;
    } = {
      baseFareCents: 600,
      perKmCents: 120,
      perMinCents: 30,
    },
    // Simula el endpoint de tarifa base CAÍDO (degradación honesta: el quote cae a las constantes).
    private readonly baseFareError?: Error,
  ) {}
  async get<T>(path: string, req: { query?: Record<string, unknown> }): Promise<T> {
    if (path.includes('/internal/pricing/bid-floor')) {
      if (this.bidFloorError) throw this.bidFloorError; // simula el piso CAÍDO (degradación)
      return { ...this.bidFloor, version: 1, updatedAt: new Date(0).toISOString() } as T;
    }
    if (path.includes('/internal/pricing/base-fare')) {
      if (this.baseFareError) throw this.baseFareError; // F2.4 · simula tarifa base CAÍDA (degradación)
      return { ...this.baseFare, version: 1, updatedAt: new Date(0).toISOString() } as T;
    }
    if (path.includes('/internal/catalog')) {
      if (this.catalogError) throw this.catalogError; // simula el catálogo CAÍDO (degradación)
      return {
        version: 1,
        updatedAt: new Date(0).toISOString(),
        offerings: OFFERING_LIST.map((o) => {
          const ov = this.catalogOverrides[o.id];
          return {
            id: o.id,
            labelKey: o.labelKey,
            icon: o.icon,
            vehicleClass: o.vehicleClass,
            // B5-4: el catálogo efectivo refleja resolveCatalog(null) = defaultEnabled (las verticales
            // nacen ocultas). Un id en disabledIds simula que el admin la apagó explícitamente.
            enabled: o.defaultEnabled && !this.disabledIds.includes(o.id),
            pricing: {
              multiplier: ov?.multiplier ?? o.pricing.multiplier,
              minFareCents: ov?.minFareCents ?? o.pricing.minFareCents,
            },
            modePin: ov?.modePin,
          };
        }),
      } as T;
    }
    this.lastQuery = req.query;
    if (this.result instanceof Error) throw this.result;
    return this.result as T;
  }
}

/** Construye el MapsService con sus dobles (trip-rest opcional, config opcional). */
function buildService(
  maps: MapsClient,
  tripRest: FakeTripRest = new FakeTripRest(),
  config: ConfigService<Env, true> = fakeConfig(),
): MapsService {
  return new MapsService(maps, tripRest as unknown as InternalRestClient, config);
}

/** Doble de prueba del MapsClient: registra llamadas y devuelve respuestas fijas. */
class FakeMapsClient implements MapsClient {
  lastAutocomplete?: { query: string; near?: { lat: number; lon: number } };
  lastReverse?: { lat: number; lon: number };
  lastRoute?: { origin: { lat: number; lon: number }; destination: { lat: number; lon: number } };

  constructor(
    private readonly responses: {
      autocomplete?: GeocodeResult[];
      reverse?: GeocodeResult | null;
      route?: RouteResult;
    } = {},
  ) {}

  async route(origin: { lat: number; lon: number }, destination: { lat: number; lon: number }) {
    this.lastRoute = { origin, destination };
    return (
      this.responses.route ?? {
        distanceMeters: 0,
        durationSeconds: 0,
        polyline: '',
        geometry: { type: 'LineString' as const, coordinates: [] },
      }
    );
  }

  async routeWithSteps(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
  ) {
    this.lastRoute = { origin, destination };
    const base = this.responses.route ?? {
      distanceMeters: 0,
      durationSeconds: 0,
      polyline: '',
      geometry: { type: 'LineString' as const, coordinates: [] },
    };
    return { ...base, steps: [] };
  }

  async eta() {
    return 0;
  }

  async etaBatch(origins: readonly { lat: number; lon: number }[]) {
    return origins.map(() => 0);
  }

  async geocode() {
    return null;
  }

  async autocomplete(query: string, opts?: { near?: { lat: number; lon: number } }) {
    this.lastAutocomplete = { query, near: opts?.near };
    return this.responses.autocomplete ?? [];
  }

  async reverse(point: { lat: number; lon: number }) {
    this.lastReverse = point;
    return this.responses.reverse ?? null;
  }
}

describe('MapsService.autocomplete', () => {
  it('devuelve [] sin pegar al cliente cuando q < 3', async () => {
    const fake = new FakeMapsClient();
    const service = buildService(fake);
    expect(await service.autocomplete('Av')).toEqual([]);
    expect(fake.lastAutocomplete).toBeUndefined();
  });

  it('mapea GeocodeResult a sugerencia con id estable y título/subtítulo', async () => {
    const fake = new FakeMapsClient({
      autocomplete: [
        {
          lat: -12.1133,
          lon: -77.029,
          displayName: 'Av. Larco, Miraflores, Lima',
          name: 'Av. Larco',
        },
      ],
    });
    const service = buildService(fake);
    const out = await service.autocomplete('Larco', -12.12, -77.03);

    expect(out).toEqual([
      {
        id: '-12.113300,-77.029000',
        title: 'Av. Larco',
        subtitle: 'Miraflores, Lima',
        lat: -12.1133,
        lng: -77.029,
      },
    ]);
    // Convierte lng→lon para el sesgo de proximidad.
    expect(fake.lastAutocomplete?.near).toEqual({ lat: -12.12, lon: -77.03 });
  });

  it('usa el primer segmento como título cuando no hay name', async () => {
    const fake = new FakeMapsClient({
      autocomplete: [{ lat: -12, lon: -77, displayName: 'Jirón de la Unión, Cercado, Lima' }],
    });
    const service = buildService(fake);
    const out = await service.autocomplete('Union');
    expect(out[0]?.title).toBe('Jirón de la Unión');
    expect(out[0]?.subtitle).toBe('Cercado, Lima');
  });
});

describe('MapsService.reverse', () => {
  it('etiqueta el punto y mapea lon→lng', async () => {
    const fake = new FakeMapsClient({
      reverse: {
        lat: -12.0464,
        lon: -77.0428,
        displayName: 'Plaza Mayor, Cercado, Lima',
        name: 'Plaza Mayor',
      },
    });
    const service = buildService(fake);
    const out = await service.reverse(-12.0464, -77.0428);
    expect(out).toEqual({
      title: 'Plaza Mayor',
      subtitle: 'Cercado, Lima',
      lat: -12.0464,
      lng: -77.0428,
    });
    expect(fake.lastReverse).toEqual({ lat: -12.0464, lon: -77.0428 });
  });

  it('lanza 404 si no hay dirección para el punto', async () => {
    const service = buildService(new FakeMapsClient({ reverse: null }));
    await expect(service.reverse(0, 0)).rejects.toBeInstanceOf(NotFoundError);
  });
});

/** Ruta de prueba reutilizable (5km / 10min). */
const ROUTE: RouteResult = {
  distanceMeters: 5000,
  durationSeconds: 600,
  polyline: 'abc',
  geometry: {
    type: 'LineString',
    coordinates: [
      [-77.0428, -12.0464],
      [-77.0297, -12.1211],
    ],
  },
};

const ORIGIN = { lat: -12.0464, lng: -77.0428 };
const DESTINATION = { lat: -12.1211, lng: -77.0297 };

// B5-4/F2.3: las ofertas VISIBLES por default (económico/normal/premium/xl; moto diferida). Las verticales
// (ambulancia/grúa/mecánico) nacen ocultas (defaultEnabled:false) → no aparecen en el quote salvo que el admin las habilite.
const VISIBLE_IDS = OFFERING_LIST.filter((o) => o.defaultEnabled).map((o) => o.id);
/** F2.4 · tarifa base de prueba (≠ las constantes) para verificar que la config mueve el quote. */
const BASE_700 = { baseFareCents: 700, perKmCents: 140, perMinCents: 40 };

describe('MapsService.quote', () => {
  it('F2.4 · la tarifa base configurada por el admin mueve el priceCents del quote', async () => {
    // Base 700/140/40 (vs 600/120/30) → económico 5km/10min = 700 + 140·5 + 40·10 = 1800 (era 1500).
    const fake = new FakeMapsClient({ route: ROUTE });
    const tripRest = new FakeTripRest(
      { mode: 'FIXED' },
      [],
      undefined,
      {},
      { defaultFloorCents: 700, overrides: [] },
      undefined,
      { baseFareCents: 700, perKmCents: 140, perMinCents: 40 },
    );
    const service = buildService(fake, tripRest);

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    const economico = out.options.find((o) => o.id === 'veo_economico');
    expect(economico?.priceCents).toBe(1800);
    // Espeja lo que el create FIXED cobraría con la misma base → sin divergencia preview-vs-cobro.
    expect(economico?.priceCents).toBe(categoryFareCents(5000, 600, 1.0, undefined, BASE_700));
  });

  it('modo FIXED: ruta + opciones con priceCents firme; SIN bidFloor/suggested', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const tripRest = new FakeTripRest({ mode: 'FIXED' });
    const service = buildService(fake, tripRest);

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    expect(out.distanceMeters).toBe(5000);
    expect(out.durationSeconds).toBe(600);
    expect(out.geometry).toEqual(ROUTE.geometry);
    expect(out.options).toHaveLength(VISIBLE_IDS.length);
    // Modo resuelto por trip-service y propagado en la respuesta.
    expect(out.mode).toBe('FIXED');
    // En FIXED no se exponen pista de puja.
    expect(out.bidFloorCents).toBeUndefined();
    expect(out.suggestedCents).toBeUndefined();
    // Ola 1 "solo autos": la moto está DIFERIDA (defaultEnabled:false) → la primera opción del quote es
    // el VEO Económico (auto). Montos deterministas (la política vive en el catálogo) + campos additive.
    expect(out.options[0]).toEqual({
      id: 'veo_economico',
      name: 'VEO Económico',
      vehicleType: 'CAR',
      etaSeconds: 600,
      priceCents: categoryFareCents(5000, 600, 1.0),
      // Sin paymentGrpc inyectado (spec construye con 3 args) → fetchCreditBalance devuelve 0 → sin preview.
      creditAppliedCents: 0,
      currency: 'PEN',
      mode: 'FIXED',
      labelKey: 'offering.veo_economico.name',
      icon: 'car',
    });
    // Otra opción de auto (confort) sigue presente con su precio determinista (el precio firme).
    const confort = out.options.find((o) => o.id === 'veo_confort');
    expect(confort?.vehicleType).toBe('CAR');
    expect(confort?.priceCents).toBe(categoryFareCents(5000, 600, 1.25, 500));
    expect(confort?.mode).toBe('FIXED');
    expect(out.options.every((o) => o.currency === 'PEN')).toBe(true);
    // Convierte lng→lon al pedir la ruta y pasa lat/lon del ORIGEN al resolver el modo.
    expect(fake.lastRoute?.origin).toEqual({ lat: -12.0464, lon: -77.0428 });
    // Quote INMEDIATO: NO se envía `at` (trip-service resuelve con now).
    expect(tripRest.lastQuery).toEqual({ lat: -12.0464, lon: -77.0428 });
  });

  // Lote C3 — el preview del crédito lo computa el SERVER (§INTEGRACIONES, no la app): cada opción trae
  // `creditAppliedCents = min(saldo, priceCents)`, topado por opción (la moto barata topa en su tarifa; la
  // económica cara topa en el saldo). Sin paymentGrpc inyectado el campo es 0 (cubierto por el test FIXED).
  it('FIXED · enriquece cada opción con creditAppliedCents = min(saldo, priceCents) (server-side)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const ecoFare = categoryFareCents(5000, 600, 1.0);
    // Saldo que ALCANZA para topear el económico (más barato) pero NO el confort (más caro) → prueba ambos topes.
    const balanceCents = ecoFare + 1;
    const paymentGrpc = { call: async () => ({ balanceCents }) };
    const service = new MapsService(
      fake,
      new FakeTripRest({ mode: 'FIXED' }) as unknown as InternalRestClient,
      fakeConfig(),
      paymentGrpc as unknown as GrpcServiceClient,
      'test-secret',
    );

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);
    const economico = out.options.find((o) => o.id === 'veo_economico');
    const confort = out.options.find((o) => o.id === 'veo_confort');

    // Saldo > tarifa económica → el crédito TOPA en la tarifa (no se descuenta más que el precio).
    expect(economico?.creditAppliedCents).toBe(ecoFare);
    // Saldo < tarifa confort → el crédito TOPA en el saldo (no se aplica más de lo que hay).
    expect(confort?.creditAppliedCents).toBe(balanceCents);
  });

  // S2 (M5) — un quote de RESERVA reenvía scheduledFor como `at` → el preview muestra el modo de la HORA
  // de recojo, no la actual.
  it('S2: quote con scheduledFor reenvía la hora de recojo como `at` al resolver el modo', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const tripRest = new FakeTripRest({ mode: 'FIXED' });
    const service = buildService(fake, tripRest);
    const pickup = '2026-06-01T22:00:00.000Z';

    await service.quote({ origin: ORIGIN, destination: DESTINATION, scheduledFor: pickup }, USER);

    expect(tripRest.lastQuery).toEqual({ lat: -12.0464, lon: -77.0428, at: pickup });
  });

  it('modo PUJA: incluye bidFloorCents (piso de la zona) + suggestedCents (ancla = tarifa fija base)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const service = buildService(fake, new FakeTripRest({ mode: 'PUJA' }), fakeConfig(700));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    expect(out.mode).toBe('PUJA');
    // El piso viene de la config (espeja trip-service).
    expect(out.bidFloorCents).toBe(700);
    // El sugerido es la tarifa que SERÍA fija con la categoría ancla (VEO Económico, mult 1.0).
    expect(out.suggestedCents).toBe(categoryFareCents(5000, 600, 1.0));
    // Las categorías siguen presentes (la app puede mostrarlas como referencia).
    expect(out.options).toHaveLength(VISIBLE_IDS.length);
    // ADR 013: con el catálogo actual (todas las ofertas permiten ambos modos) la intersección es
    // no-op → cada opción refleja el modo del schedule (PUJA).
    expect(out.options.every((o) => o.mode === 'PUJA')).toBe(true);
  });

  it('A2 · PUJA: cada oferta lleva SU piso y SU sugerido per-oferta (= su propia tarifa fija, no el ancla)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const service = buildService(fake, new FakeTripRest({ mode: 'PUJA' }), fakeConfig(700));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    // Catálogo actual: todas las ofertas permiten PUJA → todas resuelven PUJA.
    const pujaOptions = out.options.filter((o) => isPujaMode(o.mode));
    expect(pujaOptions).toHaveLength(out.options.length);

    // El sugerido per-oferta ES la tarifa que SERÍA fija de ESA oferta (= su priceCents). Antes el
    // sugerido era SIEMPRE el del ancla VEO Económico (bug); así se prueba que ya NO lo es, y que el
    // piso (display) viaja por oferta.
    for (const o of pujaOptions) {
      expect(o.suggestedCents).toBe(o.priceCents);
      expect(o.bidFloorCents).toBe(700);
    }

    // Y DIFIEREN entre ofertas (económico ×1.0 < confort ×1.25): no todas anclan al mismo precio.
    const economico = out.options.find((o) => o.id === OfferingId.VEO_ECONOMICO);
    const confort = out.options.find((o) => o.id === OfferingId.VEO_CONFORT);
    expect(economico?.suggestedCents).toBeLessThan(confort?.suggestedCents ?? 0);
  });

  it('ADR 010 §9.3 · PUJA: el piso es PER-OFERTA (override del admin gana; sin override cae al default)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    // Config del admin: económico S/3 (300), confort S/9 (900); el resto (xl) cae al default S/7.
    const tripRest = new FakeTripRest(
      { mode: 'PUJA' },
      [],
      undefined,
      {},
      {
        defaultFloorCents: 700,
        overrides: [
          { zone: 'GLOBAL', offeringId: OfferingId.VEO_ECONOMICO, floorCents: 300 },
          { zone: 'GLOBAL', offeringId: OfferingId.VEO_CONFORT, floorCents: 900 },
        ],
      },
    );
    const service = buildService(fake, tripRest, fakeConfig());

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    const floorOf = (id: OfferingId) => out.options.find((o) => o.id === id)?.bidFloorCents;
    expect(floorOf(OfferingId.VEO_ECONOMICO)).toBe(300); // override
    expect(floorOf(OfferingId.VEO_CONFORT)).toBe(900); // override
    expect(floorOf(OfferingId.VEO_XL)).toBe(700); // sin override → default
  });

  it('ADR 010 §9.3 · piso CAÍDO (trip-service no responde) → degrada al default S/7 (no rompe el quote)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const tripRest = new FakeTripRest(
      { mode: 'PUJA' },
      [],
      undefined,
      {},
      undefined,
      new Error('boom'),
    );
    const service = buildService(fake, tripRest, fakeConfig());

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    expect(out.bidFloorCents).toBe(DEFAULT_BID_FLOOR_CENTS);
    for (const o of out.options) expect(o.bidFloorCents).toBe(DEFAULT_BID_FLOOR_CENTS);
  });

  it('A2 · FIXED: las ofertas NO llevan piso ni sugerido per-oferta', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const service = buildService(fake, new FakeTripRest({ mode: 'FIXED' }), fakeConfig(700));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    for (const o of out.options) {
      expect(o.bidFloorCents).toBeUndefined();
      expect(o.suggestedCents).toBeUndefined();
    }
  });

  it('B1c · el quote EXCLUYE las ofertas deshabilitadas por el admin (overlay del catálogo)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    // El admin apagó Moto y XL en el overlay → el quote no debe cotizarlas.
    const tripRest = new FakeTripRest({ mode: 'PUJA' }, [OfferingId.VEO_MOTO, OfferingId.VEO_XL]);
    const service = buildService(fake, tripRest, fakeConfig(700));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    const ids = out.options.map((o) => o.id);
    expect(ids).not.toContain(OfferingId.VEO_MOTO);
    expect(ids).not.toContain(OfferingId.VEO_XL);
    expect(ids).toContain(OfferingId.VEO_ECONOMICO);
    expect(ids).toContain(OfferingId.VEO_CONFORT);
  });

  it('B2 · el override de multiplier del admin cambia el priceCents de la oferta en el quote', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    // admin puso multiplier 2.0 en económico (código = 1.0) → el quote debe mostrar el precio efectivo.
    const tripRest = new FakeTripRest({ mode: 'FIXED' }, [], undefined, {
      [OfferingId.VEO_ECONOMICO]: { multiplier: 2.0 },
    });
    const service = buildService(fake, tripRest, fakeConfig(700));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    const eco = out.options.find((o) => o.id === OfferingId.VEO_ECONOMICO);
    expect(eco?.priceCents).toBe(categoryFareCents(5000, 600, 2.0, 500)); // efectivo, no el de código (1.0)
    // Otra oferta sin override conserva su pricing de código.
    const confort = out.options.find((o) => o.id === OfferingId.VEO_CONFORT);
    expect(confort?.priceCents).toBe(categoryFareCents(5000, 600, 1.25, 500));
  });

  it('B2 · el pin de modo del admin GANA en el quote (schedule PUJA, pin FIXED → opción FIXED)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const tripRest = new FakeTripRest({ mode: 'PUJA' }, [], undefined, {
      [OfferingId.VEO_ECONOMICO]: { modePin: PricingMode.FIXED },
    });
    const service = buildService(fake, tripRest, fakeConfig(700));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    expect(out.options.find((o) => o.id === OfferingId.VEO_ECONOMICO)?.mode).toBe(
      PricingMode.FIXED,
    ); // pin gana
    expect(out.options.find((o) => o.id === OfferingId.VEO_CONFORT)?.mode).toBe(PricingMode.PUJA); // sin pin → schedule
  });

  it('B1c · admin APAGÓ todo (vacío legítimo) → quote SIN opciones (≠ catálogo caído, que mostraría todas)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const allIds = OFFERING_LIST.map((o) => o.id);
    const service = buildService(fake, new FakeTripRest({ mode: 'PUJA' }, allIds), fakeConfig(700));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    // Vacío LEGÍTIMO (admin apagó todas) → options=[]. Distinto del catálogo CAÍDO (degradación → todas).
    expect(out.options).toHaveLength(0);
  });

  it('degradación HONESTA: si el resolve falla, cae a PUJA (no muestra un precio fijo sin confirmar)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const tripRest = new FakeTripRest(new Error('trip-service caído'));
    const service = buildService(fake, tripRest);

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    // Ante fallo del resolve → PUJA (ADR 011 §8.2), con su piso y sugerido.
    expect(out.mode).toBe('PUJA');
    expect(out.bidFloorCents).toBe(DEFAULT_BID_FLOOR_CENTS);
    expect(out.suggestedCents).toBe(categoryFareCents(5000, 600, 1.0));
  });

  // #2 · observabilidad de la degradación del catálogo (veo_catalog_degraded_total{site}).
  async function readCatalogDegraded(site: string): Promise<number> {
    const { values } = await catalogDegradedTotal.get();
    return values.filter((v) => v.labels.site === site).reduce((s, v) => s + v.value, 0);
  }

  it('#2 · catálogo CAÍDO en el quote → bumpea veo_catalog_degraded_total{site=quote} + cotiza las VISIBLES', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const tripRest = new FakeTripRest({ mode: 'PUJA' }, [], new Error('catálogo caído'));
    const service = buildService(fake, tripRest, fakeConfig(700));
    const before = await readCatalogDegraded('quote');

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    // Degradación honesta: cotiza las visibles por default (B5-4: NO filtra las RIDE, pero TAMPOCO leakea
    // las verticales ocultas aunque el catálogo esté caído) + la métrica lo hace visible a Ops.
    expect(out.options.map((o) => o.id)).toEqual(VISIBLE_IDS);
    expect(await readCatalogDegraded('quote')).toBe(before + 1);
  });

  it('#2 · catálogo CAÍDO en la teaser → bumpea veo_catalog_degraded_total{site=teaser} + cae a las VISIBLES', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const tripRest = new FakeTripRest({ mode: 'FIXED' }, [], new Error('catálogo caído'));
    const service = buildService(fake, tripRest);
    const before = await readCatalogDegraded('teaser');

    const out = await service.catalog(USER);

    // B5-4: la teaser degradada muestra las visibles por default, NO las verticales ocultas.
    expect(out.offerings.map((o) => o.id)).toEqual(VISIBLE_IDS);
    expect(await readCatalogDegraded('teaser')).toBe(before + 1);
  });
});

/**
 * ADR 013 §1.3 (Lote C) · doble con una oferta RESTRINGIDA (solo FIXED) vía el seam protected
 * `quotedOfferings` — mismo patrón que `TripsService.resolveOffering`: el catálogo real aún no
 * tiene ofertas con `allowedModes ≠ [PUJA, FIXED]` y NO se inventa una entrada fantasma en
 * producción. Reusa `veo_confort` (auto operable) con los modos recortados (moto está diferida).
 */
const RESTRICTED_FIXED_ONLY: OfferingSpec = {
  ...OFFERINGS[OfferingId.VEO_CONFORT],
  allowedModes: [PricingMode.FIXED],
};

class RestrictedCatalogMapsService extends MapsService {
  protected override quotedOfferings(): readonly OfferingSpec[] {
    return [RESTRICTED_FIXED_ONLY, OFFERINGS[OfferingId.VEO_ECONOMICO]];
  }
}

describe('MapsService.quote · catálogo de offerings (ADR 013)', () => {
  it('las opciones SALEN de OFFERING_LIST en su orden de presentación (sortOrder)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const service = buildService(fake, new FakeTripRest({ mode: 'FIXED' }));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    // Mismos ids VISIBLES y MISMO orden que el catálogo (B5-4: las verticales ocultas no entran al quote).
    expect(out.options.map((o) => o.id)).toEqual(VISIBLE_IDS);
    const sortOrders = OFFERING_LIST.map((o) => o.sortOrder);
    expect(sortOrders).toEqual([...sortOrders].sort((a, b) => a - b));
  });

  it('cada opción lleva labelKey e icon del catálogo (tokens que la app resuelve)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const service = buildService(fake, new FakeTripRest({ mode: 'FIXED' }));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    for (const option of out.options) {
      const offering = OFFERING_LIST.find((o) => o.id === option.id);
      expect(option.labelKey).toBe(offering?.labelKey);
      expect(option.icon).toBe(offering?.icon);
      // `name` resuelto server-side se MANTIENE (compat apps viejas que no resuelven labelKey).
      expect(option.name.length).toBeGreaterThan(0);
    }
  });

  it('options[].mode = allowedModes ∩ schedule: una oferta solo-FIXED VETA la PUJA del admin', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const service = new RestrictedCatalogMapsService(
      fake,
      new FakeTripRest({ mode: 'PUJA' }) as unknown as InternalRestClient,
      fakeConfig(),
    );

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    // El top-level ancla VEO Económico (permite PUJA) → sigue al schedule, con piso y sugerido.
    expect(out.mode).toBe('PUJA');
    expect(out.bidFloorCents).toBe(DEFAULT_BID_FLOOR_CENTS);
    // La oferta restringida GANA con su modo preferido (allowedModes[0] = FIXED).
    expect(out.options.find((o) => o.id === OfferingId.VEO_CONFORT)?.mode).toBe('FIXED');
    // La oferta que sí permite el modo del schedule lo refleja tal cual.
    expect(out.options.find((o) => o.id === OfferingId.VEO_ECONOMICO)?.mode).toBe('PUJA');
  });
});
