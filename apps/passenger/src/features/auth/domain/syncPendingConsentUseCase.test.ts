import { ApiError, type ConsentRecorded, type CurrentConsent } from '@veo/api-client';
import {
  type PendingConsent,
  PendingConsentStatus,
  type PendingConsentStore,
} from './pendingConsent';
import { SyncPendingConsentUseCase } from './syncPendingConsentUseCase';
import type { RecordConsentUseCase } from './usecases';

/** Doble del use case de POST: solo `execute`, lo único que toca la cola. */
function makeRecord(execute: jest.Mock): RecordConsentUseCase {
  return { execute } as unknown as RecordConsentUseCase;
}

/** Store en memoria que implementa el puerto durable (sin MMKV). */
function makeStore(initial: PendingConsent | null): PendingConsentStore & {
  value: PendingConsent | null;
} {
  return {
    value: initial,
    read() {
      return this.value;
    },
    save(p: PendingConsent) {
      this.value = p;
    },
    clear() {
      this.value = null;
    },
  };
}

const PENDING: PendingConsent = {
  status: PendingConsentStatus.Pending,
  selection: { dataProcessing: true, inCabinCamera: true, location: true, marketing: false },
  policyVersion: '2026-05-1',
  dedupKey: '0190a0c0-0000-7000-8000-000000000000',
  capturedAt: '2026-06-15T00:00:00.000Z',
  attempts: 0,
};

const RECORDED = { id: 'c1', policyVersion: '2026-05-1' } as unknown as ConsentRecorded;

/** Error transitorio según la clasificación tipada del cliente (status 0 = red caída). */
function networkError(): ApiError {
  return new ApiError(0, 'NETWORK_ERROR', 'sin red');
}

/** Error determinista: 401 (típico del onboarding pre-login: aún no hay sesión). */
function unauthorizedError(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'sin sesión');
}

describe('SyncPendingConsentUseCase (cola durable de consentimiento · Ley 29733)', () => {
  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(1);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('cola vacía: no-op (ningún POST)', async () => {
    const execute = jest.fn();
    const store = makeStore(null);
    const sync = new SyncPendingConsentUseCase(makeRecord(execute), store);

    await sync.flush();

    expect(execute).not.toHaveBeenCalled();
  });

  it('éxito al primer intento: un POST con la MISMA dedupKey y la cola se vacía', async () => {
    const execute = jest.fn().mockResolvedValue(RECORDED);
    const store = makeStore({ ...PENDING });
    const sync = new SyncPendingConsentUseCase(makeRecord(execute), store);

    await sync.flush();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(PENDING.selection, PENDING.dedupKey);
    expect(store.value).toBeNull();
  });

  it('falla de red transitoria: reintenta con backoff y reusa la MISMA dedupKey, luego confirma', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(RECORDED);
    const store = makeStore({ ...PENDING });
    // delay inyectado no-op: el bucle de reintento avanza sin temporizadores reales.
    const sync = new SyncPendingConsentUseCase(makeRecord(execute), store, () => Promise.resolve());

    await sync.flush();

    expect(execute).toHaveBeenCalledTimes(2);
    const keys = execute.mock.calls.map((c) => c[1]);
    expect(new Set(keys).size).toBe(1); // todos los reintentos reusan el mismo dedupKey
    expect(keys[0]).toBe(PENDING.dedupKey);
    expect(store.value).toBeNull(); // confirmado → cola vacía
  });

  it('error no-retryable (401 pre-login): NO se pierde, queda Pending para el próximo disparador', async () => {
    const execute = jest.fn().mockRejectedValue(unauthorizedError());
    const store = makeStore({ ...PENDING });
    const sync = new SyncPendingConsentUseCase(makeRecord(execute), store, () => Promise.resolve());

    await sync.flush();

    expect(execute).toHaveBeenCalledTimes(1); // no insiste en caliente ante un 4xx determinista
    expect(store.value).not.toBeNull();
    expect(store.value?.status).toBe(PendingConsentStatus.Pending);
    expect(store.value?.attempts).toBe(1); // contador persistido para diagnóstico
  });

  it('flush concurrente: el segundo no se solapa mientras hay uno en vuelo', async () => {
    let resolveFirst: (v: ConsentRecorded) => void = () => undefined;
    const execute = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ConsentRecorded>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(RECORDED);
    const store = makeStore({ ...PENDING });
    const sync = new SyncPendingConsentUseCase(makeRecord(execute), store, () => Promise.resolve());

    const first = sync.flush();
    await sync.flush(); // entra y sale: hay uno en vuelo (inFlight)
    expect(execute).toHaveBeenCalledTimes(1);

    resolveFirst(RECORDED);
    await first;
    expect(store.value).toBeNull();
  });

  describe('reconcileWith', () => {
    it('misma policyVersion vigente en el server: vacía la cola (ya llegó)', () => {
      const store = makeStore({ ...PENDING });
      const sync = new SyncPendingConsentUseCase(makeRecord(jest.fn()), store);
      const current = { policyVersion: '2026-05-1' } as unknown as CurrentConsent;

      sync.reconcileWith(current);

      expect(store.value).toBeNull();
    });

    it('versión distinta: conserva la cola (lo encolado aún no llegó)', () => {
      const store = makeStore({ ...PENDING });
      const sync = new SyncPendingConsentUseCase(makeRecord(jest.fn()), store);
      const current = { policyVersion: '2025-01-1' } as unknown as CurrentConsent;

      sync.reconcileWith(current);

      expect(store.value).not.toBeNull();
    });

    it('server sin consent (null): no toca la cola', () => {
      const store = makeStore({ ...PENDING });
      const sync = new SyncPendingConsentUseCase(makeRecord(jest.fn()), store);

      sync.reconcileWith(null);

      expect(store.value).not.toBeNull();
    });
  });
});
