import type { HttpClient } from '@veo/api-client';
import { ApiError } from '@veo/api-client';
import { HttpRegistrationRepository } from '../http-registration-repository';

/**
 * Pruebas de `listDocuments` (BUG #1). Para un conductor NUEVO (recién pasó OTP) el backend aún no tiene su
 * perfil hasta el `PATCH /drivers/me/personal`, así que `GET /drivers/me/documents` responde 404 "No existe
 * un perfil de conductor para este usuario". Eso NO es un error de la app (conductor nuevo = sin documentos):
 * el repo lo mapea a una LISTA VACÍA, misma filosofía con la que el gate trata el 404 de `GET /drivers/me`.
 * Cualquier OTRO error (red/5xx/401) se PROPAGA (no se traga: no fingimos "sin documentos").
 */

/** HttpClient mínimo cuyo `get` controla el test (resuelve o rechaza). El resto no se usa acá. */
function fakeHttp(get: jest.Mock): HttpClient {
  return { get } as unknown as HttpClient;
}

describe('HttpRegistrationRepository.listDocuments · 404 sin perfil → lista vacía (BUG #1)', () => {
  it('404 (conductor nuevo sin perfil) → devuelve [] (no propaga el error)', async () => {
    const get = jest.fn(async () => {
      throw new ApiError(404, 'NOT_FOUND', 'No existe un perfil de conductor para este usuario');
    });
    const repo = new HttpRegistrationRepository(fakeHttp(get));

    await expect(repo.listDocuments()).resolves.toEqual([]);
    expect(get).toHaveBeenCalledWith('/drivers/me/documents', expect.anything());
  });

  it('respuesta OK con documentos → devuelve la lista tal cual', async () => {
    const docs = [{ type: 'LICENSE_A1', simpleStatus: 'en_revision', images: [] }];
    const get = jest.fn(async () => docs);
    const repo = new HttpRegistrationRepository(fakeHttp(get));

    await expect(repo.listDocuments()).resolves.toBe(docs);
  });

  it('error de red (status 0) → PROPAGA (no lo traga como lista vacía)', async () => {
    const networkError = new ApiError(0, 'NETWORK', 'Sin conexión');
    const get = jest.fn(async () => {
      throw networkError;
    });
    const repo = new HttpRegistrationRepository(fakeHttp(get));

    await expect(repo.listDocuments()).rejects.toBe(networkError);
  });

  it('5xx del servidor → PROPAGA (no lo traga como lista vacía)', async () => {
    const serverError = new ApiError(500, 'INTERNAL', 'Algo salió mal');
    const get = jest.fn(async () => {
      throw serverError;
    });
    const repo = new HttpRegistrationRepository(fakeHttp(get));

    await expect(repo.listDocuments()).rejects.toBe(serverError);
  });

  it('401 no autorizado → PROPAGA (un 4xx que NO es 404 no es "sin documentos")', async () => {
    const authError = new ApiError(401, 'UNAUTHORIZED', 'Sesión expirada');
    const get = jest.fn(async () => {
      throw authError;
    });
    const repo = new HttpRegistrationRepository(fakeHttp(get));

    await expect(repo.listDocuments()).rejects.toBe(authError);
  });
});
