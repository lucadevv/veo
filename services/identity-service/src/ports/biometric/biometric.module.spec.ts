import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError } from '@veo/utils';
import {
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  verifyInternalIdentity,
} from '@veo/auth';
import { BiometricServiceClient } from './biometric.module';

const SECRET = 'test-internal-secret';

/**
 * Resiliencia del cliente biométrico LIVE: es el gate del inicio de turno (shift-start) + enroll +
 * KYC. Si el biometric-service (Python/ONNX) se cuelga bajo carga de inferencia, el request DEBE
 * abortar por timeout y fallar como error de dominio tipado (ExternalServiceError, 502 reintentable)
 * en vez de colgar a toda la flota. No usamos timers falsos: con un timeout de 1ms y un fetch que
 * nunca resuelve, `AbortSignal.timeout` aborta de verdad y vemos la traducción del error.
 */
describe('BiometricServiceClient timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborta y lanza ExternalServiceError tipado cuando el proveedor no responde a tiempo', async () => {
    // fetch que respeta el AbortSignal: rechaza con AbortError cuando el timeout dispara, igual
    // que undici. NUNCA resuelve por su cuenta → solo el abort puede destrabarlo.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const client = new BiometricServiceClient('http://biometric.local', 1, SECRET);

    const err = await client
      .verify({ driverId: 'd1', challengeId: 'c1', frames: ['f'], referenceEmbedding: [0.1] })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExternalServiceError);
    expect((err as ExternalServiceError).httpStatus).toBe(502);
    expect((err as ExternalServiceError).message).toContain('no respondió a tiempo');
    expect((err as ExternalServiceError).details).toMatchObject({
      timeoutMs: 1,
      path: '/v1/verify',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('pasa el signal de timeout a fetch y mapea el caso feliz sin abortar', async () => {
    let receivedSignal: AbortSignal | undefined;
    let receivedHeaders: Record<string, string> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      receivedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      receivedHeaders = (init as RequestInit | undefined)?.headers as Record<string, string>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            result: 'ok',
            score: 0.96,
            livenessPassed: true,
            matchPassed: true,
            reason: '',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    });

    const client = new BiometricServiceClient('http://biometric.local', 20_000, SECRET);
    const out = await client.verify({
      driverId: 'd1',
      challengeId: 'c1',
      frames: ['f'],
      referenceEmbedding: [0.1],
    });

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
    // score 0..1 del servicio → 0..100 del dominio (BR-I02).
    expect(out).toEqual({ score: 96, livenessPassed: true, matchPassed: true });

    // Auth interna: manda los headers firmados y la firma VERIFICA con el secreto compartido.
    const header = receivedHeaders?.[INTERNAL_IDENTITY_HEADER];
    const sig = receivedHeaders?.[INTERNAL_IDENTITY_SIG_HEADER];
    expect(header).toBeTruthy();
    expect(sig).toBeTruthy();
    const identity = verifyInternalIdentity(header as string, sig as string, SECRET);
    expect(identity).not.toBeNull();
    expect(identity?.type).toBe('driver');
  });
});
