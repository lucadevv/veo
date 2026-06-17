import type {HttpClient} from '@veo/api-client';
import {HttpPushTokenRegistrar} from '../src/features/notifications/data/httpPushTokenRegistrar';

/** Fake mínimo del HttpClient: solo los verbos que usa el registrar. */
function makeHttp() {
  const post = jest.fn(async () => undefined);
  const del = jest.fn(async () => undefined);
  const http = {post, delete: del} as unknown as HttpClient;
  return {http, post, del};
}

describe('HttpPushTokenRegistrar', () => {
  it('register hace POST /devices con { token, platform } validado', async () => {
    const {http, post} = makeHttp();
    const registrar = new HttpPushTokenRegistrar(http);

    await registrar.register('fcm-token-abc', 'android');

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/devices', {
      body: {token: 'fcm-token-abc', platform: 'android'},
    });
  });

  it('register rechaza un token vacío (validación del contrato compartido)', async () => {
    const {http, post} = makeHttp();
    const registrar = new HttpPushTokenRegistrar(http);

    await expect(registrar.register('', 'ios')).rejects.toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('unregister hace DELETE /devices/:token (token codificado en la ruta)', async () => {
    const {http, del} = makeHttp();
    const registrar = new HttpPushTokenRegistrar(http);

    await registrar.unregister('tok/with space');

    expect(del).toHaveBeenCalledWith('/devices/tok%2Fwith%20space');
  });
});
