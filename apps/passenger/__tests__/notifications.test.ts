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
 *  - `read` REAL del server (derivado de `read_at`, requerido en el schema) → se propaga tal cual,
 *    sin hardcodear: el badge de "no leídos" refleja el estado verdadero y se limpia de verdad
 *    (PATCH /notifications/:id/read · read-all);
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

  it('mapea category→kind y propaga el read REAL del server (sin hardcodearlo)', async () => {
    const dtos: AppNotificationDto[] = [
      {
        id: 'ntf-1',
        category: 'safety',
        title: 'Verificación del conductor',
        body: 'Tu conductor pasó la verificación biométrica del turno.',
        createdAt: '2026-06-10T12:00:00.000Z',
        read: false,
      },
      {
        id: 'ntf-2',
        category: 'payment',
        title: 'Recibo de tu viaje',
        body: 'Se cargó S/ 18.50 a tu Yape.',
        createdAt: '2026-06-09T18:30:00.000Z',
        read: true,
      },
    ];
    const repository = new HttpNotificationsRepository(
      makeHttp({get: jest.fn().mockResolvedValue(dtos)}),
    );

    await expect(repository.list()).resolves.toEqual([
      {
        id: 'ntf-1',
        kind: 'SAFETY',
        title: 'Verificación del conductor',
        body: 'Tu conductor pasó la verificación biométrica del turno.',
        createdAt: '2026-06-10T12:00:00.000Z',
        read: false,
      },
      {
        id: 'ntf-2',
        kind: 'RECEIPT',
        title: 'Recibo de tu viaje',
        body: 'Se cargó S/ 18.50 a tu Yape.',
        createdAt: '2026-06-09T18:30:00.000Z',
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
