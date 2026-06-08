import { EmptyNotificationsRepository } from '../src/features/notifications/data/emptyNotificationsRepository';
import { ListNotificationsUseCase } from '../src/features/notifications/domain/usecases';

describe('Centro de avisos · degradación honesta', () => {
  it('el repositorio vacío devuelve una lista vacía (no inventa avisos)', async () => {
    const repository = new EmptyNotificationsRepository();
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('el caso de uso delega en el repositorio y propaga la lista', async () => {
    const useCase = new ListNotificationsUseCase(new EmptyNotificationsRepository());
    await expect(useCase.execute()).resolves.toEqual([]);
  });
});
