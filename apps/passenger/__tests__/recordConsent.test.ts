import type { ConsentRecorded, HttpClient, RecordConsentRequest } from '@veo/api-client';
import { HttpConsentRepository } from '../src/features/auth/data/httpConsentRepository';
import type { ConsentRepository } from '../src/features/auth/domain/consentRepository';
import {
  CONSENT_POLICY_VERSION,
  RecordConsentUseCase,
} from '../src/features/auth/domain/usecases';

const SELECTION = {
  dataProcessing: true,
  inCabinCamera: true,
  location: false,
} as const;

function recorded(input: RecordConsentRequest): ConsentRecorded {
  return {
    id: 'consent-1',
    userId: 'pax-1',
    dataProcessing: input.dataProcessing,
    inCabinCamera: input.inCabinCamera,
    location: input.location,
    policyVersion: input.policyVersion,
    acceptedAt: '2026-05-31T10:00:00.000Z',
  };
}

/** `delayMs` instantáneo: evita esperar el backoff real en los tests. */
const noWait = (): Promise<void> => Promise.resolve();

describe('RecordConsentUseCase', () => {
  it('registra el consentimiento sellando la policyVersion constante', async () => {
    const record = jest.fn(async (input: RecordConsentRequest) => recorded(input));
    const repository: ConsentRepository = { record };
    const useCase = new RecordConsentUseCase(repository, noWait);

    const result = await useCase.execute(SELECTION);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      dataProcessing: true,
      inCabinCamera: true,
      location: false,
      policyVersion: CONSENT_POLICY_VERSION,
    });
    expect(result?.id).toBe('consent-1');
  });

  it('reintenta una vez tras un fallo transitorio y devuelve el row del segundo intento', async () => {
    const record = jest
      .fn<Promise<ConsentRecorded>, [RecordConsentRequest]>()
      .mockRejectedValueOnce(new Error('network'))
      .mockImplementationOnce(async (input) => recorded(input));
    const repository: ConsentRepository = { record };
    const delayMs = jest.fn(noWait);
    const useCase = new RecordConsentUseCase(repository, delayMs);

    const result = await useCase.execute(SELECTION);

    expect(record).toHaveBeenCalledTimes(2);
    expect(delayMs).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe('consent-1');
  });

  it('degrada a null (BEST-EFFORT, no bloquea) si falla incluso tras el reintento', async () => {
    const record = jest.fn(async () => {
      throw new Error('500');
    });
    const repository: ConsentRepository = { record };
    const useCase = new RecordConsentUseCase(repository, noWait);

    const result = await useCase.execute(SELECTION);

    expect(record).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });
});

describe('HttpConsentRepository.record', () => {
  it('hace POST /users/me/consents con el body y valida la respuesta con el schema', async () => {
    const request: RecordConsentRequest = {
      dataProcessing: true,
      inCabinCamera: false,
      location: true,
      policyVersion: CONSENT_POLICY_VERSION,
    };
    const post = jest.fn(async () => recorded(request));
    const http = { post } as unknown as HttpClient;
    const repository = new HttpConsentRepository(http);

    const result = await repository.record(request);

    expect(post).toHaveBeenCalledWith('/users/me/consents', {
      body: request,
      schema: expect.anything(),
    });
    expect(result.policyVersion).toBe(CONSENT_POLICY_VERSION);
  });

  it('propaga el error del HttpClient (lo gestiona el caso de uso best-effort)', async () => {
    const post = jest.fn(async () => {
      throw new Error('401 Unauthorized');
    });
    const http = { post } as unknown as HttpClient;
    const repository = new HttpConsentRepository(http);

    await expect(
      repository.record({
        dataProcessing: true,
        inCabinCamera: true,
        location: true,
        policyVersion: CONSENT_POLICY_VERSION,
      }),
    ).rejects.toThrow(/401/);
  });
});
