import { ApiError, type HttpClient } from '@veo/api-client';
import { HttpPublisherTokenPort } from '../services/http-publisher-token';
import { PublisherTokenUnavailableError } from '../../domain/ports/trip-media-publisher';

type Handler = (method: string, path: string, opts: any) => unknown;

class FakeHttpClient {
  calls: Array<{ method: string; path: string; opts: any }> = [];
  constructor(private readonly handler: Handler) {}
  post(path: string, opts: any = {}) {
    this.calls.push({ method: 'POST', path, opts });
    return Promise.resolve().then(() => this.handler('POST', path, opts));
  }
  get(path: string, opts: any = {}) {
    this.calls.push({ method: 'GET', path, opts });
    return Promise.resolve().then(() => this.handler('GET', path, opts));
  }
  delete(path: string, opts: any = {}) {
    this.calls.push({ method: 'DELETE', path, opts });
    return Promise.resolve().then(() => this.handler('DELETE', path, opts));
  }
}

const asHttp = (h: FakeHttpClient): HttpClient => h as unknown as HttpClient;

describe('HttpPublisherTokenPort', () => {
  it('mapea driverPublisherGrant { url, token, room } a las credenciales del publisher', async () => {
    const fake = new FakeHttpClient(() => ({
      url: 'wss://livekit.veo.pe',
      token: 'jwt-publish',
      room: 'trip-abc',
    }));
    const port = new HttpPublisherTokenPort(asHttp(fake));

    const credentials = await port.fetchPublisherCredentials('trip abc');

    expect(credentials).toEqual({
      url: 'wss://livekit.veo.pe',
      token: 'jwt-publish',
      room: 'trip-abc',
    });
    expect(fake.calls[0]?.path).toBe('/media/rooms/trip%20abc/publisher-token');
  });

  it('traduce cualquier fallo a PublisherTokenUnavailableError', async () => {
    const fake = new FakeHttpClient(() => {
      throw new ApiError(404, 'NOT_FOUND', 'sin sala');
    });
    const port = new HttpPublisherTokenPort(asHttp(fake));

    await expect(port.fetchPublisherCredentials('t1')).rejects.toBeInstanceOf(
      PublisherTokenUnavailableError,
    );
  });
});
