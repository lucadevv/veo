import {
  ApiError,
  type CreateYapeAffiliation,
  type HttpClient,
} from '@veo/api-client';
import {
  AffiliationDocumentMissingError,
  AffiliationProfileIncompleteError,
  AffiliationUnsupportedError,
  AffiliationUpstreamUnavailableError,
} from '../domain/affiliationUsecases';
import {HttpAffiliationRepository} from './httpAffiliationRepository';

/** Doble mínimo de HttpClient: solo los verbos que usa el repo de afiliación. */
function makeHttp(overrides: Partial<HttpClient>): HttpClient {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

const input: CreateYapeAffiliation = {
  documentType: 'DN',
  document: '12345678',
};

describe('HttpAffiliationRepository', () => {
  it('GET devuelve la vista de afiliación tal cual', async () => {
    const http = makeHttp({
      get: jest
        .fn()
        .mockResolvedValue({status: 'ACTIVE', phoneMasked: '9*****678'}),
    });
    const repo = new HttpAffiliationRepository(http);
    await expect(repo.getYapeAffiliation()).resolves.toMatchObject({
      status: 'ACTIVE',
    });
    expect(http.get).toHaveBeenCalledWith(
      '/payments/affiliations/yape',
      expect.objectContaining({schema: expect.anything()}),
    );
  });

  it('POST propaga el deepLink del alta (PROCESS)', async () => {
    const view = {
      status: 'PROCESS',
      deepLink: 'yape://approve/x',
      affiliationId: 'x',
    };
    const http = makeHttp({post: jest.fn().mockResolvedValue(view)});
    const repo = new HttpAffiliationRepository(http);
    await expect(repo.createYapeAffiliation(input)).resolves.toMatchObject({
      status: 'PROCESS',
      deepLink: 'yape://approve/x',
    });
  });

  it('UN TAP: sin argumento manda body VACÍO {} (el server arma todo del perfil)', async () => {
    const view = {
      status: 'PROCESS',
      deepLink: 'yape://approve/x',
      affiliationId: 'x',
    };
    const post = jest.fn().mockResolvedValue(view);
    const repo = new HttpAffiliationRepository(makeHttp({post}));
    await expect(repo.createYapeAffiliation()).resolves.toMatchObject({
      status: 'PROCESS',
    });
    expect(post).toHaveBeenCalledWith(
      '/payments/affiliations/yape',
      expect.objectContaining({body: {}}),
    );
  });

  it('primera vez: manda el documento en el body (el server lo persiste en el perfil)', async () => {
    const post = jest.fn().mockResolvedValue({status: 'PROCESS'});
    const repo = new HttpAffiliationRepository(makeHttp({post}));
    await repo.createYapeAffiliation(input);
    expect(post).toHaveBeenCalledWith(
      '/payments/affiliations/yape',
      expect.objectContaining({body: input}),
    );
  });

  it('traduce 422 PROFILE_DOCUMENT_MISSING a AffiliationDocumentMissingError (revelar campo)', async () => {
    const http = makeHttp({
      post: jest
        .fn()
        .mockRejectedValue(
          new ApiError(422, 'PROFILE_DOCUMENT_MISSING', 'falta documento'),
        ),
    });
    const repo = new HttpAffiliationRepository(http);
    await expect(repo.createYapeAffiliation()).rejects.toBeInstanceOf(
      AffiliationDocumentMissingError,
    );
  });

  it('traduce 422 PROFILE_NAME_MISSING a AffiliationProfileIncompleteError (CTA al perfil)', async () => {
    const http = makeHttp({
      post: jest
        .fn()
        .mockRejectedValue(
          new ApiError(422, 'PROFILE_NAME_MISSING', 'falta nombre'),
        ),
    });
    const repo = new HttpAffiliationRepository(http);
    await expect(repo.createYapeAffiliation()).rejects.toBeInstanceOf(
      AffiliationProfileIncompleteError,
    );
  });

  it('traduce 502 UPSTREAM_UNAVAILABLE a AffiliationUpstreamUnavailableError (reintentable)', async () => {
    const http = makeHttp({
      post: jest
        .fn()
        .mockRejectedValue(
          new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'gateway ocupado'),
        ),
    });
    const repo = new HttpAffiliationRepository(http);
    await expect(repo.createYapeAffiliation()).rejects.toBeInstanceOf(
      AffiliationUpstreamUnavailableError,
    );
  });

  it('traduce 422 GATEWAY_CAPABILITY_UNAVAILABLE a AffiliationUnsupportedError (capacidad no habilitada, NO reintentable)', async () => {
    const http = makeHttp({
      post: jest.fn().mockRejectedValue(
        new ApiError(
          422,
          'GATEWAY_CAPABILITY_UNAVAILABLE',
          'capacidad no habilitada',
          {
            capability: 'YAPE_ON_FILE',
          },
        ),
      ),
    });
    const repo = new HttpAffiliationRepository(http);
    // Capacidad no habilitada → banner INFO honesto, NUNCA un error de perfil incompleto ni genérico.
    await expect(repo.createYapeAffiliation(input)).rejects.toBeInstanceOf(
      AffiliationUnsupportedError,
    );
    await expect(repo.createYapeAffiliation()).rejects.not.toBeInstanceOf(
      AffiliationProfileIncompleteError,
    );
  });

  it('NO confunde el capability 422 con los 422 de perfil: PROFILE_* siguen a sus errores propios', async () => {
    const docMissing = new HttpAffiliationRepository(
      makeHttp({
        post: jest
          .fn()
          .mockRejectedValue(
            new ApiError(422, 'PROFILE_DOCUMENT_MISSING', 'falta doc'),
          ),
      }),
    );
    await expect(docMissing.createYapeAffiliation()).rejects.toBeInstanceOf(
      AffiliationDocumentMissingError,
    );
    const nameMissing = new HttpAffiliationRepository(
      makeHttp({
        post: jest
          .fn()
          .mockRejectedValue(
            new ApiError(422, 'PROFILE_NAME_MISSING', 'falta nombre'),
          ),
      }),
    );
    await expect(nameMissing.createYapeAffiliation()).rejects.toBeInstanceOf(
      AffiliationProfileIncompleteError,
    );
  });

  it('compat: el 409 honesto del entorno sigue mapeando a AffiliationUnsupportedError', async () => {
    const http = makeHttp({
      post: jest
        .fn()
        .mockRejectedValue(
          new ApiError(409, 'AFFILIATION_UNSUPPORTED', 'gateway no soporta'),
        ),
    });
    const repo = new HttpAffiliationRepository(http);
    await expect(repo.createYapeAffiliation(input)).rejects.toBeInstanceOf(
      AffiliationUnsupportedError,
    );
  });

  it('traduce el 422 (perfil sin nombre) a AffiliationProfileIncompleteError', async () => {
    const http = makeHttp({
      post: jest
        .fn()
        .mockRejectedValue(
          new ApiError(422, 'PROFILE_INCOMPLETE', 'completá tu nombre'),
        ),
    });
    const repo = new HttpAffiliationRepository(http);
    await expect(repo.createYapeAffiliation(input)).rejects.toBeInstanceOf(
      AffiliationProfileIncompleteError,
    );
  });

  it('propaga otros errores HTTP sin envolverlos (p. ej. 500)', async () => {
    const boom = new ApiError(500, 'INTERNAL', 'boom');
    const http = makeHttp({post: jest.fn().mockRejectedValue(boom)});
    const repo = new HttpAffiliationRepository(http);
    await expect(repo.createYapeAffiliation(input)).rejects.toBe(boom);
  });

  it('DELETE revoca contra el endpoint de afiliación', async () => {
    const http = makeHttp({
      delete: jest.fn().mockResolvedValue({status: 'REVOKED'}),
    });
    const repo = new HttpAffiliationRepository(http);
    await expect(repo.revokeYapeAffiliation()).resolves.toMatchObject({
      status: 'REVOKED',
    });
    expect(http.delete).toHaveBeenCalledWith(
      '/payments/affiliations/yape',
      expect.objectContaining({schema: expect.anything()}),
    );
  });
});
