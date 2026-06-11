import { ApiError, type PanicTriggerResult } from '@veo/api-client';
import { NotImplementedError } from '../../../core/errors/notImplemented';
import type { PanicEscalation } from './panicEscalation';
import { SilentPanicDispatcher } from './silentPanicDispatcher';
import type { TriggerPanicUseCase } from './usecases';

/** Doble del use case: solo `execute`, que es lo único que toca el dispatcher. */
function makeTrigger(execute: jest.Mock): TriggerPanicUseCase {
  return { execute } as unknown as TriggerPanicUseCase;
}

function makeEscalation(): PanicEscalation & { escalate: jest.Mock } {
  return { escalate: jest.fn() };
}

const RESULT: PanicTriggerResult = {
  panicId: 'panic-1',
  deduplicated: false,
} as PanicTriggerResult;

/** Error transitorio según la clasificación TIPADA del cliente (status 0 = red caída). */
function networkError(): ApiError {
  return new ApiError(0, 'NETWORK_ERROR', 'sin red');
}

describe('SilentPanicDispatcher (entrega at-least-once del pánico silencioso)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Jitter determinista (= delay completo) para que la línea de tiempo del test sea exacta.
    jest.spyOn(Math, 'random').mockReturnValue(1);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('confirmación al primer intento: un solo POST, sin reintentos ni escalamiento', async () => {
    const execute = jest.fn().mockResolvedValue(RESULT);
    const escalation = makeEscalation();
    const dispatcher = new SilentPanicDispatcher(makeTrigger(execute), escalation);

    dispatcher.dispatch('trip-1');
    await jest.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('trip-1', expect.any(String));
    expect(escalation.escalate).not.toHaveBeenCalled();
  });

  it('falla de red transitoria: reintenta con backoff y el MISMO dedupKey (idempotencia server-side)', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(RESULT);
    const escalation = makeEscalation();
    const dispatcher = new SilentPanicDispatcher(makeTrigger(execute), escalation);

    dispatcher.dispatch('trip-1');
    await jest.advanceTimersByTimeAsync(1_000); // primer backoff (1s)

    expect(execute).toHaveBeenCalledTimes(2);
    const [, firstKey] = execute.mock.calls[0] as [string, string];
    const [, retryKey] = execute.mock.calls[1] as [string, string];
    expect(retryKey).toBe(firstKey); // misma alerta, no una nueva
    expect(escalation.escalate).not.toHaveBeenCalled();
  });

  it('error determinista (4xx no retryable): NO reintenta a ciegas y escala de inmediato', async () => {
    const execute = jest.fn().mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'payload inválido'));
    const escalation = makeEscalation();
    const dispatcher = new SilentPanicDispatcher(makeTrigger(execute), escalation);

    dispatcher.dispatch('trip-1');
    await jest.advanceTimersByTimeAsync(200_000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(escalation.escalate).toHaveBeenCalledTimes(1);
    expect(escalation.escalate).toHaveBeenCalledWith('trip-1');
  });

  it('puerto nativo ausente (NotImplementedError): escala sin reintentar (el puerto no aparece solo)', async () => {
    const execute = jest.fn().mockRejectedValue(new NotImplementedError('location.getCurrentPosition'));
    const escalation = makeEscalation();
    const dispatcher = new SilentPanicDispatcher(makeTrigger(execute), escalation);

    dispatcher.dispatch('trip-1');
    await jest.advanceTimersByTimeAsync(200_000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(escalation.escalate).toHaveBeenCalledTimes(1);
  });

  it('red caída persistente: agota el presupuesto (~2 min de backoff) y deja de ser silencioso', async () => {
    const execute = jest.fn().mockRejectedValue(networkError());
    const escalation = makeEscalation();
    const dispatcher = new SilentPanicDispatcher(makeTrigger(execute), escalation);

    dispatcher.dispatch('trip-1');
    // Con jitter determinista: intentos en t=0,1,3,7,15,31,61,91s; a los 91s la próxima espera
    // (30s) excedería el presupuesto de 120s → escala. 8 intentos en total.
    await jest.advanceTimersByTimeAsync(200_000);

    expect(execute).toHaveBeenCalledTimes(8);
    const keys = execute.mock.calls.map((call) => (call as [string, string])[1]);
    expect(new Set(keys).size).toBe(1); // TODOS los reintentos reusan el mismo dedupKey
    expect(escalation.escalate).toHaveBeenCalledTimes(1);
    expect(escalation.escalate).toHaveBeenCalledWith('trip-1');
  });

  it('segundo disparo del MISMO viaje con uno en vuelo: se ignora (no fabrica otra alerta)', async () => {
    let resolveFirst: (value: PanicTriggerResult) => void = () => undefined;
    const execute = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<PanicTriggerResult>((resolve) => { resolveFirst = resolve; }),
      )
      .mockResolvedValue(RESULT);
    const escalation = makeEscalation();
    const dispatcher = new SilentPanicDispatcher(makeTrigger(execute), escalation);

    dispatcher.dispatch('trip-1');
    dispatcher.dispatch('trip-1'); // en vuelo → ignorado
    await jest.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);

    resolveFirst(RESULT);
    await jest.advanceTimersByTimeAsync(0);

    // Confirmada la primera, un disparo nuevo SÍ genera otra alerta (con dedupKey nuevo).
    // Avanzamos el reloj: con Math.random fijo, el uuidv7 solo varía por su timestamp (ms).
    await jest.advanceTimersByTimeAsync(10);
    dispatcher.dispatch('trip-1');
    await jest.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2);
    const [, firstKey] = execute.mock.calls[0] as [string, string];
    const [, secondKey] = execute.mock.calls[1] as [string, string];
    expect(secondKey).not.toBe(firstKey);
  });
});
