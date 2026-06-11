import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import type { GeocodeResult, MapsClient, RouteResult } from '@veo/maps';
import type { InternalRestClient } from '@veo/rpc';
import {
  OFFERING_LIST,
  OFFERINGS,
  OfferingId,
  PricingMode,
  type OfferingSpec,
} from '@veo/shared-types';
import { MapsService } from './maps.service';
import { categoryFareCents, DEFAULT_BID_FLOOR_CENTS } from './fare';
import type { Env } from '../config/env.schema';

/** Identidad de prueba del pasajero (la quote la firma para la lectura interna del modo). */
const USER: AuthenticatedUser = { userId: 'p1', type: 'passenger', roles: [], sessionId: 's1' };

/** ConfigService falso: solo devuelve el piso de la PUJA. */
function fakeConfig(bidFloorCents = DEFAULT_BID_FLOOR_CENTS): ConfigService<Env, true> {
  return { getOrThrow: () => bidFloorCents } as unknown as ConfigService<Env, true>;
}

/**
 * Doble del cliente REST interno hacia trip-service. Devuelve un `{ mode }` fijo o, si se le pasa un
 * error, lo lanza (para probar la degradación). Registra la última query (lat/lon del origen).
 */
class FakeTripRest {
  lastQuery?: Record<string, unknown>;
  constructor(
    private readonly result: { mode: 'PUJA' | 'FIXED' } | Error = { mode: 'FIXED' },
  ) {}
  async get<T>(_path: string, req: { query?: Record<string, unknown> }): Promise<T> {
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

  async routeWithSteps(origin: { lat: number; lon: number }, destination: { lat: number; lon: number }) {
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
        { lat: -12.1133, lon: -77.029, displayName: 'Av. Larco, Miraflores, Lima', name: 'Av. Larco' },
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
      reverse: { lat: -12.0464, lon: -77.0428, displayName: 'Plaza Mayor, Cercado, Lima', name: 'Plaza Mayor' },
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
    await expect(service.reverse(0, 0)).rejects.toBeInstanceOf(NotFoundException);
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

describe('MapsService.quote', () => {
  it('modo FIXED: ruta + opciones con priceCents firme; SIN bidFloor/suggested', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const tripRest = new FakeTripRest({ mode: 'FIXED' });
    const service = buildService(fake, tripRest);

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    expect(out.distanceMeters).toBe(5000);
    expect(out.durationSeconds).toBe(600);
    expect(out.geometry).toEqual(ROUTE.geometry);
    expect(out.options).toHaveLength(OFFERING_LIST.length);
    // Modo resuelto por trip-service y propagado en la respuesta.
    expect(out.mode).toBe('FIXED');
    // En FIXED no se exponen pista de puja.
    expect(out.bidFloorCents).toBeUndefined();
    expect(out.suggestedCents).toBeUndefined();
    // Ola 2B: la primera opción es el tier MOTO (mototaxi, vehicleType MOTO). MISMOS montos que
    // antes del ADR 013 (la política se MOVIÓ al catálogo, no cambió) + campos additive.
    expect(out.options[0]).toEqual({
      id: 'veo_moto',
      name: 'VEO Moto',
      vehicleType: 'MOTO',
      etaSeconds: 600,
      priceCents: categoryFareCents(5000, 600, 0.55, 300),
      currency: 'PEN',
      mode: 'FIXED',
      labelKey: 'offering.veo_moto.name',
      icon: 'moto',
    });
    // La opción económica (auto) sigue presente con su precio determinista (el precio firme).
    const economico = out.options.find((o) => o.id === 'veo_economico');
    expect(economico).toEqual({
      id: 'veo_economico',
      name: 'VEO Económico',
      vehicleType: 'CAR',
      etaSeconds: 600,
      priceCents: categoryFareCents(5000, 600, 1.0),
      currency: 'PEN',
      mode: 'FIXED',
      labelKey: 'offering.veo_economico.name',
      icon: 'car',
    });
    expect(out.options.every((o) => o.currency === 'PEN')).toBe(true);
    // Convierte lng→lon al pedir la ruta y pasa lat/lon del ORIGEN al resolver el modo.
    expect(fake.lastRoute?.origin).toEqual({ lat: -12.0464, lon: -77.0428 });
    // Quote INMEDIATO: NO se envía `at` (trip-service resuelve con now).
    expect(tripRest.lastQuery).toEqual({ lat: -12.0464, lon: -77.0428 });
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
    expect(out.options).toHaveLength(OFFERING_LIST.length);
    // ADR 013: con el catálogo actual (todas las ofertas permiten ambos modos) la intersección es
    // no-op → cada opción refleja el modo del schedule (PUJA).
    expect(out.options.every((o) => o.mode === 'PUJA')).toBe(true);
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
});

/**
 * ADR 013 §1.3 (Lote C) · doble con una oferta RESTRINGIDA (solo FIXED) vía el seam protected
 * `quotedOfferings` — mismo patrón que `TripsService.resolveOffering`: el catálogo real aún no
 * tiene ofertas con `allowedModes ≠ [PUJA, FIXED]` y NO se inventa una entrada fantasma en
 * producción. Reusa `veo_moto` con los modos recortados.
 */
const RESTRICTED_FIXED_ONLY_MOTO: OfferingSpec = {
  ...OFFERINGS[OfferingId.VEO_MOTO],
  allowedModes: [PricingMode.FIXED],
};

class RestrictedCatalogMapsService extends MapsService {
  protected override quotedOfferings(): readonly OfferingSpec[] {
    return [RESTRICTED_FIXED_ONLY_MOTO, OFFERINGS[OfferingId.VEO_ECONOMICO]];
  }
}

describe('MapsService.quote · catálogo de offerings (ADR 013)', () => {
  it('las opciones SALEN de OFFERING_LIST en su orden de presentación (sortOrder)', async () => {
    const fake = new FakeMapsClient({ route: ROUTE });
    const service = buildService(fake, new FakeTripRest({ mode: 'FIXED' }));

    const out = await service.quote({ origin: ORIGIN, destination: DESTINATION }, USER);

    // Mismos ids y MISMO orden que el catálogo (OFFERING_LIST ya viene ordenado por sortOrder).
    expect(out.options.map((o) => o.id)).toEqual(OFFERING_LIST.map((o) => o.id));
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
    expect(out.options.find((o) => o.id === OfferingId.VEO_MOTO)?.mode).toBe('FIXED');
    // La oferta que sí permite el modo del schedule lo refleja tal cual.
    expect(out.options.find((o) => o.id === OfferingId.VEO_ECONOMICO)?.mode).toBe('PUJA');
  });
});
