import { describe, it, expect, vi } from 'vitest';
import { ValidationError, ExternalServiceError, type LatLon } from '@veo/utils';
import type { MapsClient, RouteResult } from '@veo/maps';
import { CostCapService, type PriceCapInput } from './cost-cap.service';
import type { CostPerKmService } from './cost-per-km.service';
import { PAIS, type CostPerKmConfig } from '../domain/cost-cap';

const CONFIG: CostPerKmConfig = { [PAIS.PE]: 100, [PAIS.EC]: 50 };

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

function makeService(maps: MapsClient, config: CostPerKmConfig = CONFIG): CostCapService {
  return new CostCapService(maps, config);
}

/** Input full-route simple (sin stopovers, 1 tramo full-route con precioBase). */
function makeInput(over: Partial<PriceCapInput> = {}): PriceCapInput {
  return {
    pais: PAIS.PE,
    asientosTotales: 4,
    precioBaseCentimos: 250,
    origenLat: -12.05,
    origenLon: -77.04,
    destinoLat: -12.1,
    destinoLon: -77.0,
    stopovers: [],
    tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 250 }],
    ...over,
  };
}

describe('CostCapService · gate F1b full-route', () => {
  it('precioBase <= tope → publica OK (no lanza)', async () => {
    // 10km · PE(100c) · 4 asientos → tope 250; precioBase 250 == tope.
    const { maps, route } = makeMaps(async () => routeOf(10_000));
    const service = makeService(maps);

    await expect(service.assertPriceCap(makeInput({ precioBaseCentimos: 250 }))).resolves.toBeUndefined();
    expect(route).toHaveBeenCalled();
  });

  it('precioBase > tope → ValidationError con el tope esperado (250)', async () => {
    const { maps } = makeMaps(async () => routeOf(10_000)); // tope 250
    const service = makeService(maps);

    await expect(
      service.assertPriceCap(makeInput({ precioBaseCentimos: 251 })),
    ).rejects.toMatchObject({ details: { topeCentimos: 250, precioBaseCentimos: 251 } });
    await expect(service.assertPriceCap(makeInput({ precioBaseCentimos: 251 }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('EC usa COST_PER_KM_CENTS_EC (50): 10km · 4 asientos → tope 125', async () => {
    // (10 * 50) / 4 = 125. precioBase 130 > 125 → rechaza; 125 → OK.
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

describe('CostCapService · gate F1b por tramo', () => {
  it('un tramo con precio > topeTramo → ValidationError', async () => {
    // Dos tramos sobre 1 stopover (orden 1), destino orden 2. Cada route → 5km → tope (5*100)/2=250.
    const { maps } = makeMaps(async () => routeOf(5_000));
    const service = makeService(maps);

    const input = makeInput({
      asientosTotales: 2,
      precioBaseCentimos: 250, // full-route lo mockea a 5km igual → tope 250, pasa
      stopovers: [{ lat: -12.07, lon: -77.02, orden: 1 }],
      tramos: [
        { desdeOrden: 0, hastaOrden: 1, precioCentimos: 250 }, // OK
        { desdeOrden: 1, hastaOrden: 2, precioCentimos: 300 }, // > 250 → rechaza
      ],
    });

    await expect(service.assertPriceCap(input)).rejects.toMatchObject({
      details: { desdeOrden: 1, hastaOrden: 2, topeCentimos: 250 },
    });
  });

  it('paraleliza las llamadas de tramo (Promise.all): full-route + N tramos', async () => {
    const { maps, route } = makeMaps(async () => routeOf(4_000)); // (4*100)/2 = 200
    const service = makeService(maps);

    const input = makeInput({
      asientosTotales: 2,
      precioBaseCentimos: 200,
      stopovers: [{ lat: -12.07, lon: -77.02, orden: 1 }],
      tramos: [
        { desdeOrden: 0, hastaOrden: 1, precioCentimos: 200 },
        { desdeOrden: 1, hastaOrden: 2, precioCentimos: 200 },
      ],
    });

    await expect(service.assertPriceCap(input)).resolves.toBeUndefined();
    // 1 full-route + 2 tramos = 3 llamadas.
    expect(route).toHaveBeenCalledTimes(3);
  });
});

describe('CostCapService · FIX 1 — invariante de hitos (orden colisionante burla el tope por tramo)', () => {
  it('stopover orden=0 → ValidationError (pisaría el origen, NO last-write-wins)', async () => {
    const { maps } = makeMaps(async () => routeOf(5_000));
    const service = makeService(maps);
    await expect(
      service.assertPriceCap(
        makeInput({
          stopovers: [{ lat: -12.07, lon: -77.02, orden: 0 }],
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 250 }],
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
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 250 }],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('stopover en orden = destino (n+1) → ValidationError (pisaría el destino)', async () => {
    // 1 stopover → n=1 → destino=2. Un stopover en orden 2 colisiona con el destino.
    const { maps } = makeMaps(async () => routeOf(5_000));
    const service = makeService(maps);
    await expect(
      service.assertPriceCap(
        makeInput({
          stopovers: [{ lat: -12.07, lon: -77.02, orden: 2 }],
          tramos: [{ desdeOrden: 0, hastaOrden: 1, precioCentimos: 250 }],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('tramo {0→1} con stopover legítimo en orden 1 calcula la distancia desde el ORIGEN real', async () => {
    // Con stopover en orden 1, destino = 2. El tramo 0→1 debe rutear desde el ORIGEN (input.origen*) hasta el
    // stopover, NO desde un stopover inyectado en 0. Verificamos que alguna llamada tiene origin = el origen real.
    const { maps, route } = makeMaps(async () => routeOf(4_000)); // (4*100)/2 = 200
    const service = makeService(maps);

    const input = makeInput({
      asientosTotales: 2,
      precioBaseCentimos: 200,
      origenLat: -12.05,
      origenLon: -77.04,
      stopovers: [{ lat: -12.07, lon: -77.02, orden: 1 }],
      tramos: [
        { desdeOrden: 0, hastaOrden: 1, precioCentimos: 200 },
        { desdeOrden: 1, hastaOrden: 2, precioCentimos: 200 },
      ],
    });

    await expect(service.assertPriceCap(input)).resolves.toBeUndefined();
    // El tramo 0→1 ruteó con origin = el ORIGEN real (no un stopover inyectado en orden 0).
    const origins = route.mock.calls.map((call) => call[0] as LatLon);
    const ruteoDesdeOrigen = origins.some((o) => o.lat === -12.05 && o.lon === -77.04);
    expect(ruteoDesdeOrigen).toBe(true);
  });
});

describe('CostCapService · F2.5 — usa el costo/km DERIVADO (CostPerKmService) en vez del env', () => {
  it('el tope se calcula con el costo/km del resolutor vivo, no con el env', async () => {
    // 10km · 4 asientos. Con el resolutor devolviendo 200 c/km → tope (10*200)/4 = 500 (NO 250 del env PE=100).
    const { maps } = makeMaps(async () => routeOf(10_000));
    const getCostPerKmCents = vi.fn(async () => 200);
    const costPerKm = { getCostPerKmCents } as unknown as CostPerKmService;
    const service = new CostCapService(maps, CONFIG, costPerKm);

    // precioBase 500 == tope derivado → OK; 501 > tope → rechaza con topeCentimos 500.
    await expect(
      service.assertPriceCap(makeInput({ precioBaseCentimos: 500 })),
    ).resolves.toBeUndefined();
    await expect(
      service.assertPriceCap(makeInput({ precioBaseCentimos: 501 })),
    ).rejects.toMatchObject({ details: { topeCentimos: 500 } });
    expect(getCostPerKmCents).toHaveBeenCalledWith(PAIS.PE);
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
