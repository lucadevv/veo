import type {
  AppNotification as AppNotificationDto,
  HttpClient,
} from '@veo/api-client';
import {HttpNotificationsRepository} from '../src/features/notifications/data/httpNotificationsRepository';
import {ListNotificationsUseCase} from '../src/features/notifications/domain/usecases';

/** Doble mínimo de HttpClient: solo el verbo que usa el repositorio de avisos. */
function makeHttp(overrides: Partial<HttpClient>): HttpClient {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

/**
 * Degradación HONESTA del centro de avisos. Antes vivía en `EmptyNotificationsRepository` (stub
 * vacío mientras no había endpoint); desde 5fd0754 el feed es REAL (`GET /notifications` del
 * public-bff) y la honestidad se reparte así:
 *  - bandeja vacía en el backend → lista vacía (NUNCA avisos inventados);
 *  - sin estado leído/no-leído en el backend (MVP) → `read: true` (no se finge un badge de
 *    "no leídos" que jamás se limpiaría);
 *  - error de red → el repositorio PROPAGA (no degrada a lista vacía mintiendo "no tienes avisos";
 *    la pantalla muestra su `ErrorState` con reintento).
 */
describe('Centro de avisos · degradación honesta', () => {
  it('bandeja vacía en el backend → lista vacía (no inventa avisos)', async () => {
    const get = jest.fn().mockResolvedValue([]);
    const repository = new HttpNotificationsRepository(makeHttp({get}));

    await expect(repository.list()).resolves.toEqual([]);
    expect(get).toHaveBeenCalledWith(
      '/notifications',
      expect.objectContaining({schema: expect.anything()}),
    );
  });

  it('mapea category→kind y marca read:true (sin badge de no-leídos fingido)', async () => {
    const dto: AppNotificationDto = {
      id: 'ntf-1',
      category: 'safety',
      title: 'Verificación del conductor',
      body: 'Tu conductor pasó la verificación biométrica del turno.',
      createdAt: '2026-06-10T12:00:00.000Z',
    };
    const repository = new HttpNotificationsRepository(
      makeHttp({get: jest.fn().mockResolvedValue([dto])}),
    );

    await expect(repository.list()).resolves.toEqual([
      {
        id: 'ntf-1',
        kind: 'SAFETY',
        title: 'Verificación del conductor',
        body: 'Tu conductor pasó la verificación biométrica del turno.',
        createdAt: '2026-06-10T12:00:00.000Z',
        read: true,
      },
    ]);
  });

  it('error del backend → propaga (no miente con una bandeja vacía)', async () => {
    const failure = new Error('network down');
    const repository = new HttpNotificationsRepository(
      makeHttp({get: jest.fn().mockRejectedValue(failure)}),
    );

    await expect(repository.list()).rejects.toBe(failure);
  });

  it('el caso de uso delega en el repositorio y propaga la lista', async () => {
    const repository = new HttpNotificationsRepository(
      makeHttp({get: jest.fn().mockResolvedValue([])}),
    );
    const useCase = new ListNotificationsUseCase(repository);

    await expect(useCase.execute()).resolves.toEqual([]);
  });
});
