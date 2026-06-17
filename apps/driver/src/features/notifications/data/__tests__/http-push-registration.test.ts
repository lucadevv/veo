import { ApiError, type HttpClient } from '@veo/api-client';
import { HttpPushRegistrationPort } from '../http-push-registration';
import { PushRegistrationUnavailableError } from '../../domain/ports/push';

type Handler = (method: string, path: string, opts: any) => unknown;

class FakeHttpClient {
  calls: Array<{ method: string; path: string; opts: any }> = [];
  constructor(private readonly handler: Handler = () => undefined) {}
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

describe('HttpPushRegistrationPort', () => {
  it('registra el token con POST y el cuerpo validado por el contrato', async () => {
    const fake = new FakeHttpClient();
    const port = new HttpPushRegistrationPort(asHttp(fake));

    await port.registerDeviceToken({ token: 'tok-123', platform: 'android' });

    expect(fake.calls[0]).toMatchObject({
      method: 'POST',
      path: '/notifications/device-token',
      opts: { body: { token: 'tok-123', platform: 'android' } },
    });
  });

  it('da de baja el token con DELETE y el token URL-encoded', async () => {
    const fake = new FakeHttpClient();
    const port = new HttpPushRegistrationPort(asHttp(fake));

    await port.unregisterDeviceToken('tok/abc');

    expect(fake.calls[0]?.method).toBe('DELETE');
    expect(fake.calls[0]?.path).toBe('/notifications/device-token/tok%2Fabc');
  });

  it('rechaza un platform inválido (validación del contrato) sin llamar a la red', async () => {
    const fake = new FakeHttpClient();
    const port = new HttpPushRegistrationPort(asHttp(fake));

    await expect(
      port.registerDeviceToken({ token: 't', platform: 'web' as never }),
    ).rejects.toBeInstanceOf(PushRegistrationUnavailableError);
    expect(fake.calls).toHaveLength(0);
  });

  it('traduce fallos HTTP a PushRegistrationUnavailableError', async () => {
    const fake = new FakeHttpClient(() => {
      throw new ApiError(500, 'SERVER', 'boom');
    });
    const port = new HttpPushRegistrationPort(asHttp(fake));

    await expect(port.unregisterDeviceToken('t')).rejects.toBeInstanceOf(
      PushRegistrationUnavailableError,
    );
  });
});
