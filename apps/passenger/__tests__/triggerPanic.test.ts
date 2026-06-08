import {
  ApiError,
  type GeoPoint,
  type PanicTriggerRequest,
  type PanicTriggerResult,
  type PanicView,
} from '@veo/api-client';
import { NotImplementedError } from '../src/core/errors/notImplemented';
import { UnavailableLocationProvider } from '../src/shared/location/data/unavailableLocationProvider';
import { UnavailablePanicSigner } from '../src/features/panic/data/unavailablePanicSigner';
import type { LocationProvider } from '../src/shared/location/domain/locationProvider';
import type { PanicRepository } from '../src/features/panic/domain/panicRepository';
import type { PanicSecretProvisioner } from '../src/features/panic/domain/panicSecretProvisioner';
import type { PanicSigner } from '../src/features/panic/domain/panicSigner';
import { TriggerPanicUseCase } from '../src/features/panic/domain/usecases';

const OK_RESULT: PanicTriggerResult = {
  panicId: 'panic-1',
  status: 'RECEIVED',
  deduplicated: false,
  triggeredAt: '2026-05-29T10:00:00.000Z',
  evidenceS3Keys: [],
};

class FakePanicRepository implements PanicRepository {
  trigger = jest.fn(async (_input: PanicTriggerRequest): Promise<PanicTriggerResult> => OK_RESULT);
  getPanic = jest.fn(async (_id: string): Promise<PanicView> => ({} as PanicView));
}

class FakeLocation implements LocationProvider {
  getCurrentPosition = jest.fn(async (): Promise<GeoPoint> => ({ lat: -12.04, lon: -77.04 }));
  watchPosition = jest.fn(() => () => undefined);
}

class FakeSigner implements PanicSigner {
  sign = jest.fn(async (): Promise<string> => 'deadbeef');
}

class FakeProvisioner implements PanicSecretProvisioner {
  ensureProvisioned = jest.fn(async (): Promise<void> => undefined);
  refresh = jest.fn(async (): Promise<void> => undefined);
}

describe('TriggerPanicUseCase', () => {
  it('aprovisiona el secreto y orquesta ubicación + firma + repo', async () => {
    const repo = new FakePanicRepository();
    const location = new FakeLocation();
    const signer = new FakeSigner();
    const provisioner = new FakeProvisioner();
    const useCase = new TriggerPanicUseCase(repo, location, signer, provisioner);

    const result = await useCase.execute('11111111-1111-1111-1111-111111111111');

    expect(provisioner.ensureProvisioned).toHaveBeenCalledTimes(1);
    expect(location.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(repo.trigger).toHaveBeenCalledTimes(1);
    const sentBody = repo.trigger.mock.calls[0]![0];
    expect(sentBody.signature).toBe('deadbeef');
    expect(sentBody.dedupKey).toMatch(/[0-9a-f-]{36}/);
    expect(result.panicId).toBe('panic-1');
  });

  it('rota la clave y reintenta UNA vez ante un 401 de firma (mismo dedupKey)', async () => {
    const repo = new FakePanicRepository();
    repo.trigger
      .mockRejectedValueOnce(new ApiError(401, 'PANIC_SIGNATURE_INVALID', 'firma inválida'))
      .mockResolvedValueOnce(OK_RESULT);
    const signer = new FakeSigner();
    const provisioner = new FakeProvisioner();
    const useCase = new TriggerPanicUseCase(repo, new FakeLocation(), signer, provisioner);

    const result = await useCase.execute('11111111-1111-1111-1111-111111111111');

    expect(provisioner.refresh).toHaveBeenCalledTimes(1);
    expect(repo.trigger).toHaveBeenCalledTimes(2);
    expect(signer.sign).toHaveBeenCalledTimes(2);
    // El dedupKey se mantiene entre el intento original y el reintento (idempotencia).
    expect(repo.trigger.mock.calls[0]![0].dedupKey).toBe(repo.trigger.mock.calls[1]![0].dedupKey);
    expect(result.panicId).toBe('panic-1');
  });

  it('no reintenta más de una vez: si el 401 persiste, propaga el error', async () => {
    const repo = new FakePanicRepository();
    repo.trigger.mockRejectedValue(new ApiError(401, 'PANIC_SIGNATURE_INVALID', 'firma inválida'));
    const provisioner = new FakeProvisioner();
    const useCase = new TriggerPanicUseCase(repo, new FakeLocation(), new FakeSigner(), provisioner);

    await expect(useCase.execute('trip')).rejects.toBeInstanceOf(ApiError);
    expect(provisioner.refresh).toHaveBeenCalledTimes(1);
    expect(repo.trigger).toHaveBeenCalledTimes(2);
  });

  it('no rota ante errores que no son 401 de firma (p. ej. 500)', async () => {
    const repo = new FakePanicRepository();
    repo.trigger.mockRejectedValue(new ApiError(500, 'INTERNAL', 'fallo del servidor'));
    const provisioner = new FakeProvisioner();
    const useCase = new TriggerPanicUseCase(repo, new FakeLocation(), new FakeSigner(), provisioner);

    await expect(useCase.execute('trip')).rejects.toBeInstanceOf(ApiError);
    expect(provisioner.refresh).not.toHaveBeenCalled();
    expect(repo.trigger).toHaveBeenCalledTimes(1);
  });

  it('propaga NotImplementedError si los puertos nativos no están (sin datos inventados)', async () => {
    const repo = new FakePanicRepository();
    const useCase = new TriggerPanicUseCase(
      repo,
      new UnavailableLocationProvider(),
      new UnavailablePanicSigner(),
      new FakeProvisioner(),
    );

    await expect(useCase.execute('trip')).rejects.toBeInstanceOf(NotImplementedError);
    expect(repo.trigger).not.toHaveBeenCalled();
  });
});
