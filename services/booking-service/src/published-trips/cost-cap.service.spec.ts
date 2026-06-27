import { describe, it, expect, vi } from 'vitest';
import { ValidationError, ExternalServiceError, type LatLon } from '@veo/utils';
import type { MapsClient, RouteResult } from '@veo/maps';
import { CostCapService, type PriceCapInput } from './cost-cap.service';
import type { CostPerKmConfigService } from '../cost-per-km/cost-per-km-config.service';
import { PAIS } from '../domain/cost-cap';

/** Costo/km de prueba: PE=150 (seed real), EC=50 — lo que la config del admin resuelve (degradación incluida). */
const COST_PER_KM: Record<string, number> = { [PAIS.PE]: 150, [PAIS.EC]: 50 };

/** RouteResult mínimo con la distancia que el test quiere (lo único que el gate F1b consume). */
function routeOf(distanceMeters: number): RouteResult {
  return {
    distanceMeters,
    durationSeconds: 0,
    polyline: '',
    geometry: { type: 'LineString', coordinates: [] },
  };
}

/**
 * MapsClient MOCKEADO — NUNCA toca OSRM. `route` devuelve la distancia que dicte `routeFn` (por defecto
 * fija). El resto de métodos del puerto no se usan en el gate → stubs que lanzan si alguien los llama.
 */
function makeMaps(routeFn: () => Promise<RouteResult>): { maps: MapsClient; route: ReturnType<typeof vi.fn> } {
  const route = vi.fn(routeFn);
  const notUsed = () => {
    throw new Error('no debería llamarse en el gate F1b');
  };
  const maps = {
    route,
    routeWithSteps: notUsed,
    eta: notUsed,
    etaBatch: notUsed,
    geocode: notUsed,
    autocomplete: notUsed,
    reverse: notUsed,
  } as unknown as MapsClient;
  return { maps, route };
}

/** Fake del CostPerKmConfigService: resuelve el costo/km del admin (degradación incluida en el servicio real). */
function makeCostPerKm(
  getCostPerKmCents: (pais: string) => Promise<number> = async (pais) => COST_PER_KM[pais] ?? 0,
): { svc: CostPerKmConfigService; getCostPerKmCents: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(getCostPerKmCents);
  return { svc: { getCostPerKmCents: spy } as unknown as CostPerKmConfigService, getCostPerKmCents: spy };
}

function makeService(
  maps: MapsClient,
  costPerKm: CostPerKmConfigService = makeCostPerKm().svc,
): CostCapService {
  return new CostCapService(maps, costPerKm);
}

/** Input full-route simple (sin stopovers, 1 tramo full-route con precioBase, sin peaje). */
function makeInput(over: Partial<PriceCapInput> = {}): PriceCapInput {
  return {
    pais: PAIS.PE,
    asientosTotales: 4,
    precioBaseCentimos: 375,
    tollsCents: 0,
    origenLat: -12.05,
    origenLon: -77.04,
    destinoLat: -12.1,
    destinoLon: -77.0,
    stopovers: [],
    tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 375 }],
    ...over,
  };
}

describe('CostCapService · gate F1b full-route (costo/km DIRECTO del admin)', () => {
  it('precioBase <= tope → publica OK (no lanza)', async () => {
    // 10km · PE(150c) · 4 asientos → tope 375; precioBase 375 == tope.
    const { maps, route } = makeMaps(async () => routeOf(10_000));
    const service = makeService(maps);

    await expect(service.assertPriceCap(makeInput({ precioBaseCentimos: 375 }))).resolves.toBeUndefined();
    expect(route).toHaveBeenCalled();
  });

  it('precioBase > tope → ValidationError con el tope esperado (375)', async () => {
    const { maps } = makeMaps(async () => routeOf(10_000)); // tope 375
    const service = makeService(maps);

    await expect(
      service.assertPriceCap(makeInput({ precioBaseCentimos: 376 })),
    ).rejects.toMatchObject({ details: { topeCentimos: 375, precioBaseCentimos: 376 } });
    await expect(service.assertPriceCap(makeInput({ precioBaseCentimos: 376 }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('lee el costo/km de la config del admin (per-país), no de un valor fijo', async () => {
    // El servicio resuelve 200 c/km → 10km/4 asientos → tope (10*200)/4 = 500 (NO 375 del seed PE=150).
    const { maps } = makeMaps(async () => routeOf(10_000));
    const { svc, getCostPerKmCents } = makeCostPerKm(async () => 200);
    const service = makeService(maps, svc);

    await expect(
      service.assertPriceCap(makeInput({ precioBaseCentimos: 500 })),
    ).resolves.toBeUndefined();
    await expect(
      service.assertPriceCap(makeInput({ precioBaseCentimos: 501 })),
    ).rejects.toMatchObject({ details: { topeCentimos: 500 } });
    expect(getCostPerKmCents).toHaveBeenCalledWith(PAIS.PE);
  });

  it('EC usa el costo/km de EC (50): 10km · 4 asientos → tope 125', async () => {
    const { maps } = makeMaps(async () => routeOf(10_000));
    const service = makeService(maps);

    await expect(
      service.assertPriceCap(
        makeInput({
          pais: PAIS.EC,
          precioBaseCentimos: 130,
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 125 }],
        }),
      ),
    ).rejects.toMatchObject({ details: { topeCentimos: 125 } });
    await expect(
      service.assertPriceCap(
        makeInput({
          pais: PAIS.EC,
          precioBaseCentimos: 125,
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 125 }],
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('CostCapService · PEAJE (entra al full-route, NO a los tramos)', () => {
  it('el peaje declarado SUBE el tope full-route: 10km · PE(150) · 4 asientos · peaje 800 → (1500+800)/4 = 575', async () => {
    const { maps } = makeMaps(async () => routeOf(10_000));
    const service = makeService(maps);

    // precioBase 575 == tope CON peaje → OK; sin peaje el tope sería 375 y 575 reventaría.
    await expect(
      service.assertPriceCap(
        makeInput({
          tollsCents: 800,
          precioBaseCentimos: 575,
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 575 }],
        }),
      ),
    ).resolves.toBeUndefined();
    // 576 excede el tope incluso con peaje.
    await expect(
      service.assertPriceCap(
        makeInput({
          tollsCents: 800,
          precioBaseCentimos: 576,
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 575 }],
        }),
      ),
    ).rejects.toMatchObject({ details: { topeCentimos: 575, tollsCents: 800 } });
  });

  it('el peaje NO infla el tope de un TRAMO: un tramo se topa por su distancia pura, sin el peaje del viaje', async () => {
    // Dos tramos sobre 1 stopover (orden 1), destino 2. Cada route → 5km → topeTramo (5*150)/2 = 375 (SIN peaje).
    const { maps } = makeMaps(async () => routeOf(5_000));
    const service = makeService(maps);

    const input = makeInput({
      asientosTotales: 2,
      precioBaseCentimos: 575, // full-route 5km → (5*150 + 800)/2 = (750+800)/2 = 775 → 575 pasa
      tollsCents: 800,
      stopovers: [{ lat: -12.07, lon: -77.02, orden: 1 }],
      tramos: [
        { desdeOrden: 0, hastaOrden: 1, precioCentimos: 375 }, // == topeTramo (sin peaje) → OK
        { desdeOrden: 1, hastaOrden: 2, precioCentimos: 376 }, // > topeTramo 375 (el peaje NO lo sube) → rechaza
      ],
    });

    await expect(service.assertPriceCap(input)).rejects.toMatchObject({
      details: { desdeOrden: 1, hastaOrden: 2, topeCentimos: 375 },
    });
  });
});

describe('CostCapService · gate F1b por tramo', () => {
  it('un tramo con precio > topeTramo → ValidationError', async () => {
    // Dos tramos sobre 1 stopover (orden 1), destino orden 2. Cada route → 5km → tope (5*150)/2=375.
    const { maps } = makeMaps(async () => routeOf(5_000));
    const service = makeService(maps);

    const input = makeInput({
      asientosTotales: 2,
      precioBaseCentimos: 375, // full-route lo mockea a 5km igual → tope 375, pasa
      stopovers: [{ lat: -12.07, lon: -77.02, orden: 1 }],
      tramos: [
        { desdeOrden: 0, hastaOrden: 1, precioCentimos: 375 }, // OK
        { desdeOrden: 1, hastaOrden: 2, precioCentimos: 400 }, // > 375 → rechaza
      ],
    });

    await expect(service.assertPriceCap(input)).rejects.toMatchObject({
      details: { desdeOrden: 1, hastaOrden: 2, topeCentimos: 375 },
    });
  });

  it('paraleliza las llamadas de tramo (Promise.all): full-route + N tramos', async () => {
    const { maps, route } = makeMaps(async () => routeOf(4_000)); // (4*150)/2 = 300
    const service = makeService(maps);

    const input = makeInput({
      asientosTotales: 2,
      precioBaseCentimos: 300,
      stopovers: [{ lat: -12.07, lon: -77.02, orden: 1 }],
      tramos: [
        { desdeOrden: 0, hastaOrden: 1, precioCentimos: 300 },
        { desdeOrden: 1, hastaOrden: 2, precioCentimos: 300 },
      ],
    });

    await expect(service.assertPriceCap(input)).resolves.toBeUndefined();
    // 1 full-route + 2 tramos = 3 llamadas.
    expect(route).toHaveBeenCalledTimes(3);
  });
});

describe('CostCapService · invariante de hitos (orden colisionante burla el tope por tramo)', () => {
  it('stopover orden=0 → ValidationError (pisaría el origen, NO last-write-wins)', async () => {
    const { maps } = makeMaps(async () => routeOf(5_000));
    const service = makeService(maps);
    await expect(
      service.assertPriceCap(
        makeInput({
          stopovers: [{ lat: -12.07, lon: -77.02, orden: 0 }],
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 375 }],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('dos stopovers con el MISMO orden → ValidationError (se pisarían)', async () => {
    const { maps } = makeMaps(async () => routeOf(5_000));
    const service = makeService(maps);
    await expect(
      service.assertPriceCap(
        makeInput({
          stopovers: [
            { lat: -12.07, lon: -77.02, orden: 1 },
            { lat: -12.08, lon: -77.03, orden: 1 },
          ],
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 375 }],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('stopover en orden = destino (n+1) → ValidationError (pisaría el destino)', async () => {
    const { maps } = makeMaps(async () => routeOf(5_000));
    const service = makeService(maps);
    await expect(
      service.assertPriceCap(
        makeInput({
          stopovers: [{ lat: -12.07, lon: -77.02, orden: 2 }],
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 375 }],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('tramo {0→1} con stopover legítimo en orden 1 calcula la distancia desde el ORIGEN real', async () => {
    const { maps, route } = makeMaps(async () => routeOf(4_000)); // (4*150)/2 = 300
    const service = makeService(maps);

    const input = makeInput({
      asientosTotales: 2,
      precioBaseCentimos: 300,
      origenLat: -12.05,
      origenLon: -77.04,
      stopovers: [{ lat: -12.07, lon: -77.02, orden: 1 }],
      tramos: [
        { desdeOrden: 0, hastaOrden: 1, precioCentimos: 300 },
        { desdeOrden: 1, hastaOrden: 2, precioCentimos: 300 },
      ],
    });

    await expect(service.assertPriceCap(input)).resolves.toBeUndefined();
    const origins = route.mock.calls.map((call) => call[0] as LatLon);
    const ruteoDesdeOrigen = origins.some((o) => o.lat === -12.05 && o.lon === -77.04);
    expect(ruteoDesdeOrigen).toBe(true);
  });
});

describe('CostCapService · FAIL-CLOSED', () => {
  it('OSRM falla (route rejected) → ExternalServiceError, NO se publica', async () => {
    const { maps } = makeMaps(async () => {
      throw new ExternalServiceError('OSRM no devolvió ruta', { code: 'NoRoute' });
    });
    const service = makeService(maps);

    await expect(service.assertPriceCap(makeInput())).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('timeout/red (Error genérico) → se traduce a ExternalServiceError (fail-closed)', async () => {
    const { maps } = makeMaps(async () => {
      throw new Error('ETIMEDOUT');
    });
    const service = makeService(maps);

    await expect(service.assertPriceCap(makeInput())).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
