import { ApiError, type GeoPoint, type HttpClient } from '@veo/api-client';
import { HttpDispatchRepository } from '../src/features/dispatch/data/httpDispatchRepository';
import { GetNearbyVehiclesUseCase } from '../src/features/dispatch/domain/usecases';

const lima: GeoPoint = { lat: -12.003267, lon: -77.063354 };

/** Fake mínimo del HttpClient con los cuatro verbos. */
function fakeHttp(overrides: Partial<HttpClient>): HttpClient {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

describe('HttpDispatchRepository', () => {
  it('getNearbyVehicles() pega a /dispatch/nearby con lat/lon y SIN vehicleType cuando no se filtra', async () => {
    const get = jest.fn(async () => ({
      vehicles: [{ lat: -12.0033, lon: -77.0634, vehicleType: 'CAR' as const }],
    }));
    const repo = new HttpDispatchRepository(fakeHttp({ get }));

    const view = await repo.getNearbyVehicles(lima);

    expect(get).toHaveBeenCalledTimes(1);
    const [path, opts] = get.mock.calls[0] as [string, { query: Record<string, unknown> }];
    expect(path).toBe('/dispatch/nearby');
    expect(opts.query).toEqual({ lat: lima.lat, lon: lima.lon });
    expect(opts.query).not.toHaveProperty('vehicleType');
    expect(view.vehicles).toHaveLength(1);
  });

  it('getNearbyVehicles() incluye vehicleType en la query cuando se filtra por tipo', async () => {
    const get = jest.fn(async () => ({ vehicles: [] }));
    const repo = new HttpDispatchRepository(fakeHttp({ get }));

    await repo.getNearbyVehicles(lima, 'MOTO');

    const [, opts] = get.mock.calls[0] as [string, { query: Record<string, unknown> }];
    expect(opts.query).toEqual({ lat: lima.lat, lon: lima.lon, vehicleType: 'MOTO' });
  });
});

describe('GetNearbyVehiclesUseCase · ambiente que NUNCA falla en pantalla', () => {
  it('devuelve la lista de vehículos en el camino feliz', async () => {
    const vehicles = [
      { lat: -12.0033, lon: -77.0634, vehicleType: 'CAR' as const },
      { lat: -12.005, lon: -77.06, vehicleType: 'MOTO' as const },
    ];
    const repo = { getNearbyVehicles: jest.fn(async () => ({ vehicles })) };
    const usecase = new GetNearbyVehiclesUseCase(repo);

    await expect(usecase.execute(lima)).resolves.toEqual(vehicles);
  });

  it('degrada a lista VACÍA ante un 4xx del bff (no propaga el error)', async () => {
    const repo = {
      getNearbyVehicles: jest.fn(async () => {
        throw new ApiError('bad request', 400);
      }),
    };
    const usecase = new GetNearbyVehiclesUseCase(repo);

    await expect(usecase.execute(lima)).resolves.toEqual([]);
  });

  it('degrada a lista VACÍA ante un fallo de red (no propaga el error)', async () => {
    const repo = {
      getNearbyVehicles: jest.fn(async () => {
        throw new Error('network down');
      }),
    };
    const usecase = new GetNearbyVehiclesUseCase(repo);

    await expect(usecase.execute(lima)).resolves.toEqual([]);
  });

  it('propaga el filtro vehicleType al repositorio', async () => {
    const getNearbyVehicles = jest.fn(async () => ({ vehicles: [] }));
    const usecase = new GetNearbyVehiclesUseCase({ getNearbyVehicles });

    await usecase.execute(lima, 'CAR');

    expect(getNearbyVehicles).toHaveBeenCalledWith(lima, 'CAR');
  });
});
