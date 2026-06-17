import type {AvatarUploadTicket, HttpClient} from '@veo/api-client';
import {HttpAvatarUploader} from '../src/shared/media/data/httpAvatarUploader';
import {AvatarUploadError} from '../src/shared/media/domain/avatarUploader';
import type {PickedImage} from '../src/shared/media/domain/imagePickerService';
import {
  RemoveAvatarUseCase,
  UploadAvatarUseCase,
} from '../src/features/profile/domain/usecases';
import type {ProfileRepository} from '../src/features/profile/domain/profileRepository';
import {HttpProfileRepository} from '../src/features/profile/data/httpProfileRepository';

/** Imagen base de prueba (JPEG con URI local). */
const jpegFile: PickedImage = {
  uri: 'file:///tmp/avatar.jpg',
  mimeType: 'image/jpeg',
  fileName: 'avatar.jpg',
  width: 800,
  height: 800,
  fileSize: 12345,
};

/** Ticket de subida válido devuelto por el BFF. */
const ticket: AvatarUploadTicket = {
  uploadUrl: 'https://minio.veo.test/avatars/abc.jpg?sig=xyz',
  method: 'PUT',
  headers: {'Content-Type': 'image/jpeg'},
  key: 'avatars/abc.jpg',
  publicUrl: 'https://cdn.veo.test/avatars/abc.jpg',
  expiresInSeconds: 300,
  maxBytes: 5 * 1024 * 1024,
};

/** Respuesta del confirm: la `publicUrl` SELLADA difiere de la del ticket para probar que se usa esta. */
const confirmed = {
  key: ticket.key,
  publicUrl: 'https://cdn.veo.test/avatars/confirmed.jpg',
  sizeBytes: 10,
};

/** `http.post` que despacha por ruta: presign → ticket, confirm → confirmed. */
function makeFlowPost(): jest.Mock {
  return jest.fn(async (path: string) =>
    path === '/users/me/avatar/confirm' ? confirmed : ticket,
  );
}

/** Crea un `HttpClient` fake cuyo `post` devuelve un ticket (o lanza). */
function makeHttp(postImpl: jest.Mock): HttpClient {
  return {post: postImpl} as unknown as HttpClient;
}

/** `fetch` fake: primera llamada lee el blob local, segunda hace el PUT a MinIO. */
function makeFetch(options?: {uploadOk?: boolean; uploadStatus?: number}) {
  const blob = {size: 10, type: 'image/jpeg'} as Blob;
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!init) {
      // Lectura del archivo local → expone `.blob()`.
      return {blob: async () => blob} as unknown as Response;
    }
    // PUT a MinIO.
    return {
      ok: options?.uploadOk ?? true,
      status: options?.uploadStatus ?? 200,
    } as unknown as Response;
  });
}

describe('HttpAvatarUploader', () => {
  it('pide el ticket, sube el binario con PUT, confirma y devuelve la publicUrl SELLADA', async () => {
    const post = makeFlowPost();
    const fetchImpl = makeFetch();
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      fetchImpl as unknown as typeof fetch,
    );

    const result = await uploader.uploadAvatar(jpegFile);

    // Usa la publicUrl del CONFIRM (autoritativa), no la del ticket.
    expect(result).toEqual({photoUrl: confirmed.publicUrl});
    // 1) presign con el descriptor derivado del MIME.
    expect(post).toHaveBeenNthCalledWith(1, '/users/me/avatar/presign', {
      body: {contentType: 'image/jpeg', ext: 'jpg'},
      schema: expect.anything(),
    });
    // 2) lectura local del archivo (sin init).
    expect(fetchImpl).toHaveBeenNthCalledWith(1, jpegFile.uri);
    // 3) PUT crudo a MinIO con los headers del ticket (sin Authorization).
    expect(fetchImpl).toHaveBeenNthCalledWith(2, ticket.uploadUrl, {
      method: 'PUT',
      headers: ticket.headers,
      body: expect.anything(),
    });
    const putInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect(
      (putInit.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
    // 4) confirm con la key del ticket (vía cliente autenticado del BFF).
    expect(post).toHaveBeenNthCalledWith(2, '/users/me/avatar/confirm', {
      body: {key: ticket.key},
      schema: expect.anything(),
    });
  });

  it('lanza AvatarUploadError(too-large) y NO sube ni confirma si la imagen excede maxBytes', async () => {
    const post = makeFlowPost();
    const bigBlob = {size: ticket.maxBytes + 1, type: 'image/jpeg'} as Blob;
    const fetchImpl = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init) {
          return {blob: async () => bigBlob} as unknown as Response;
        }
        return {ok: true, status: 200} as unknown as Response;
      },
    );
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      fetchImpl as unknown as typeof fetch,
    );

    await expect(uploader.uploadAvatar(jpegFile)).rejects.toMatchObject({
      reason: 'too-large',
    });
    // Solo leyó el binario local; nunca intentó el PUT a MinIO.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Solo pidió el presign; nunca confirmó.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      '/users/me/avatar/presign',
      expect.anything(),
    );
  });

  it('lanza AvatarUploadError(confirm) si el backend rechaza la confirmación (cuota servidor)', async () => {
    const post = jest.fn(async (path: string) => {
      if (path === '/users/me/avatar/confirm') {
        throw new Error('400 Bad Request: avatar excede la cuota');
      }
      return ticket;
    });
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      makeFetch() as unknown as typeof fetch,
    );

    await expect(uploader.uploadAvatar(jpegFile)).rejects.toMatchObject({
      reason: 'confirm',
    });
    // El PUT sí ocurrió (read + PUT), pero el confirm falló.
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('deriva el descriptor por extensión cuando no hay MIME (png)', async () => {
    const post = jest.fn(async () => ticket);
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      makeFetch() as unknown as typeof fetch,
    );

    await uploader.uploadAvatar({
      ...jpegFile,
      mimeType: null,
      fileName: 'foto.PNG',
    });

    expect(post).toHaveBeenCalledWith(
      '/users/me/avatar/presign',
      expect.objectContaining({body: {contentType: 'image/png', ext: 'png'}}),
    );
  });

  it('lanza AvatarUploadError(unsupported-type) si el formato no está en la lista blanca', async () => {
    const post = jest.fn(async () => ticket);
    const fetchImpl = makeFetch();
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      fetchImpl as unknown as typeof fetch,
    );

    await expect(
      uploader.uploadAvatar({
        ...jpegFile,
        mimeType: 'image/gif',
        fileName: 'foto.gif',
        uri: 'file:///tmp/foto.gif',
      }),
    ).rejects.toMatchObject({reason: 'unsupported-type'});
    // Ni siquiera pide el ticket si el formato es inválido.
    expect(post).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lanza AvatarUploadError(presign) si el BFF falla al expedir el ticket', async () => {
    const post = jest.fn(async () => {
      throw new Error('500');
    });
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      makeFetch() as unknown as typeof fetch,
    );

    await expect(uploader.uploadAvatar(jpegFile)).rejects.toBeInstanceOf(
      AvatarUploadError,
    );
    await expect(uploader.uploadAvatar(jpegFile)).rejects.toMatchObject({
      reason: 'presign',
    });
  });

  it('lanza AvatarUploadError(upload) si MinIO responde un status != 2xx', async () => {
    const post = jest.fn(async () => ticket);
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      makeFetch({
        uploadOk: false,
        uploadStatus: 403,
      }) as unknown as typeof fetch,
    );

    await expect(uploader.uploadAvatar(jpegFile)).rejects.toMatchObject({
      reason: 'upload',
    });
  });

  it('lanza AvatarUploadError(network) si el PUT del binario falla por red', async () => {
    const post = jest.fn(async () => ticket);
    const fetchImpl = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init) {
          return {
            blob: async () => ({size: 10}) as Blob,
          } as unknown as Response;
        }
        throw new Error('network down');
      },
    );
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      fetchImpl as unknown as typeof fetch,
    );

    await expect(uploader.uploadAvatar(jpegFile)).rejects.toMatchObject({
      reason: 'network',
    });
  });

  it('lanza AvatarUploadError(read) si no se puede abrir el archivo local (content:// frágil)', async () => {
    const post = jest.fn(async () => ticket);
    const fetchImpl = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init) {
          throw new Error('unable to resolve content://');
        }
        return {ok: true, status: 200} as unknown as Response;
      },
    );
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      fetchImpl as unknown as typeof fetch,
    );

    await expect(
      uploader.uploadAvatar({
        ...jpegFile,
        uri: 'content://media/external/images/1',
      }),
    ).rejects.toMatchObject({reason: 'read'});
    // No intenta el PUT a MinIO si no pudo leer el binario local.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lanza AvatarUploadError(read) si la respuesta local no soporta blob()', async () => {
    const post = jest.fn(async () => ticket);
    const fetchImpl = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init) {
          // Respuesta sin método blob() (polyfill/RN sobre content://).
          return {} as unknown as Response;
        }
        return {ok: true, status: 200} as unknown as Response;
      },
    );
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      fetchImpl as unknown as typeof fetch,
    );

    await expect(uploader.uploadAvatar(jpegFile)).rejects.toMatchObject({
      reason: 'read',
    });
  });

  it('lanza AvatarUploadError(read) si el blob local viene vacío (0 bytes)', async () => {
    const post = jest.fn(async () => ticket);
    const fetchImpl = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init) {
          return {blob: async () => ({size: 0}) as Blob} as unknown as Response;
        }
        return {ok: true, status: 200} as unknown as Response;
      },
    );
    const uploader = new HttpAvatarUploader(
      makeHttp(post),
      fetchImpl as unknown as typeof fetch,
    );

    await expect(uploader.uploadAvatar(jpegFile)).rejects.toMatchObject({
      reason: 'read',
    });
  });
});

describe('UploadAvatarUseCase', () => {
  it('sube el avatar y persiste la photoUrl con PATCH /users/me', async () => {
    const uploadAvatar = jest.fn(async () => ({photoUrl: ticket.publicUrl}));
    const updateMe = jest.fn(async (input: {photoUrl?: string}) => ({
      id: 'pax',
      name: 'María',
      email: null,
      photoUrl: input.photoUrl ?? null,
    }));
    const repository = {updateMe} as unknown as ProfileRepository;
    const useCase = new UploadAvatarUseCase({uploadAvatar}, repository);

    const profile = await useCase.execute(jpegFile);

    expect(uploadAvatar).toHaveBeenCalledWith(jpegFile);
    expect(updateMe).toHaveBeenCalledWith({photoUrl: ticket.publicUrl});
    expect(profile.photoUrl).toBe(ticket.publicUrl);
  });

  it('propaga el error del uploader sin tocar el repositorio', async () => {
    const uploadAvatar = jest.fn(async () => {
      throw new AvatarUploadError('upload', 'boom');
    });
    const updateMe = jest.fn();
    const repository = {updateMe} as unknown as ProfileRepository;
    const useCase = new UploadAvatarUseCase({uploadAvatar}, repository);

    await expect(useCase.execute(jpegFile)).rejects.toMatchObject({
      reason: 'upload',
    });
    expect(updateMe).not.toHaveBeenCalled();
  });
});

describe('RemoveAvatarUseCase', () => {
  it('revierte la foto en el backend (clearAvatar) y devuelve el perfil sin photoUrl', async () => {
    const clearAvatar = jest.fn(async () => ({
      id: 'pax',
      name: 'María',
      email: null,
      photoUrl: null,
    }));
    const repository = {clearAvatar} as unknown as ProfileRepository;
    const useCase = new RemoveAvatarUseCase(repository);

    const profile = await useCase.execute();

    expect(clearAvatar).toHaveBeenCalledTimes(1);
    expect(profile.photoUrl).toBeNull();
  });
});

describe('HttpProfileRepository.clearAvatar', () => {
  it('hace PATCH /users/me con { photoUrl: null } para quitar la foto en backend', async () => {
    const fullProfile = {
      id: 'pax',
      phone: '51999111222',
      type: 'PASSENGER',
      kycStatus: 'VERIFIED',
      name: 'María',
      email: null,
      photoUrl: null,
    };
    const patch = jest.fn(async () => fullProfile);
    const http = {patch} as unknown as HttpClient;
    const repository = new HttpProfileRepository(http);

    const result = await repository.clearAvatar();

    expect(patch).toHaveBeenCalledWith(
      '/users/me',
      expect.objectContaining({body: {photoUrl: null}}),
    );
    expect(result.photoUrl).toBeNull();
  });
});
