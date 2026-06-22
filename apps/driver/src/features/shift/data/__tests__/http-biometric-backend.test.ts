import { ApiError, type HttpClient } from '@veo/api-client';
import { HttpBiometricBackendPort } from '../services/http-biometric-backend';
import {
  BiometricBackendUnavailableError,
  BiometricNotEnrolledError,
  BiometricRejectedError,
} from '../../domain';

type Handler = (method: string, path: string, opts: any) => unknown;

/** Doble de prueba del HttpClient (no es un mock de producción): registra llamadas y responde/lanza. */
class FakeHttpClient {
  calls: Array<{ method: string; path: string; opts: any }> = [];
  constructor(private readonly handler: Handler) {}
  post(path: string, opts: any = {}) {
    return this.run('POST', path, opts);
  }
  delete(path: string, opts: any = {}) {
    return this.run('DELETE', path, opts);
  }
  get(path: string, opts: any = {}) {
    return this.run('GET', path, opts);
  }
  private async run(method: string, path: string, opts: any) {
    this.calls.push({ method, path, opts });
    return this.handler(method, path, opts);
  }
}

const asHttp = (h: FakeHttpClient): HttpClient => h as unknown as HttpClient;

describe('HttpBiometricBackendPort', () => {
  it('verify exitoso devuelve sessionRef y envía el cuerpo del contrato', async () => {
    const fake = new FakeHttpClient(() => ({
      sessionRef: 'sess-1',
      score: 0.93,
      livenessPassed: true,
      matchPassed: true,
    }));
    const port = new HttpBiometricBackendPort(asHttp(fake));

    const result = await port.verify({ challengeId: 'c1', frames: ['ZmE='] });

    expect(result.sessionRef).toBe('sess-1');
    expect(fake.calls[0]?.path).toBe('/drivers/shift/biometric/verify');
    expect(fake.calls[0]?.opts.body).toEqual({ challengeId: 'c1', frames: ['ZmE='] });
  });

  it('verify con liveness/match fallido lanza BiometricRejectedError', async () => {
    const fake = new FakeHttpClient(() => ({
      sessionRef: 'sess-x',
      score: 0.2,
      livenessPassed: false,
      matchPassed: true,
    }));
    const port = new HttpBiometricBackendPort(asHttp(fake));

    await expect(port.verify({ challengeId: 'c1', frames: ['x'] })).rejects.toBeInstanceOf(
      BiometricRejectedError,
    );
  });

  it('mapea 409/422 a BiometricNotEnrolledError', async () => {
    const fake = new FakeHttpClient(() => {
      throw new ApiError(409, 'NOT_ENROLLED', 'Rostro no registrado');
    });
    const port = new HttpBiometricBackendPort(asHttp(fake));

    await expect(port.requestChallenge()).rejects.toBeInstanceOf(BiometricNotEnrolledError);
  });

  it('mapea 403 a BiometricLockedError con el mensaje del backend', async () => {
    const fake = new FakeHttpClient(() => {
      throw new ApiError(403, 'LOCKED', 'Bloqueado 1 hora');
    });
    const port = new HttpBiometricBackendPort(asHttp(fake));

    await expect(port.verify({ challengeId: 'c1', frames: ['x'] })).rejects.toMatchObject({
      name: 'BiometricLockedError',
      message: 'Bloqueado 1 hora',
    });
  });

  it('mapea 5xx/red a BiometricBackendUnavailableError', async () => {
    const fake = new FakeHttpClient(() => {
      throw new ApiError(0, 'NETWORK_ERROR', 'sin red');
    });
    const port = new HttpBiometricBackendPort(asHttp(fake));

    await expect(port.requestChallenge()).rejects.toBeInstanceOf(BiometricBackendUnavailableError);
  });

  it('enroll envía el contrato de selfie { photo } y devuelve enrolledAt', async () => {
    const fake = new FakeHttpClient(() => ({ enrolled: true, enrolledAt: '2026-05-29T00:00:00Z' }));
    const port = new HttpBiometricBackendPort(asHttp(fake));
    // base64 que supera el piso de 2_000 chars del schema driverBiometricEnrollRequest.
    const photo = 'A'.repeat(2_100);

    const result = await port.enroll({ photo });

    expect(result.enrolledAt).toBe('2026-05-29T00:00:00Z');
    expect(fake.calls[0]?.path).toBe('/drivers/biometric/enroll');
    expect(fake.calls[0]?.opts.body).toEqual({ photo });
  });
});
