import type { HttpClient } from '@veo/api-client';
import { DocumentUploadError } from '../../domain/ports/document-uploader';
import type { PickedImage } from '../../domain/ports/image-picker-service';
import { HttpDocumentUploader } from '../uploaders/http-document-uploader';

const FILE: PickedImage = {
  uri: 'file:///tmp/license.jpg',
  mimeType: 'image/jpeg',
  fileName: 'license.jpg',
  width: 1024,
  height: 768,
  fileSize: 120_000,
};

const TICKET = {
  uploadUrl: 'https://storage.veo.local/bucket/drivers/d-1/license.jpg?sig=abc',
  fileS3Key: 'drivers/d-1/license.jpg',
  requiredHeaders: { 'Content-Type': 'image/jpeg' },
  expiresAt: '2026-06-18T12:00:00.000Z',
};

/** Stub del `HttpClient`: solo necesitamos `post` (el presign); el resto no se invoca. */
function httpStub(post: jest.Mock): HttpClient {
  return { post } as unknown as HttpClient;
}

/** Respuesta local "leíble": un fake con `.blob()` que devuelve un objeto con `size`. */
function localReadOk(size = 120_000): Response {
  return {
    blob: async () => ({ size }) as Blob,
  } as unknown as Response;
}

describe('HttpDocumentUploader', () => {
  it('happy path: presign por el BFF → lee blob local → PUT crudo al almacén con los headers firmados', async () => {
    const post = jest.fn(async () => TICKET);
    // fetchImpl: 1ª llamada = lectura local (uri), 2ª = PUT al uploadUrl.
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(localReadOk())
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const uploader = new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch);
    const result = await uploader.upload('LICENSE_A1', FILE);

    // 1) Presign: el body lleva el tipo y el contentType derivado del MIME (allowlist).
    expect(post).toHaveBeenCalledWith(
      '/drivers/me/documents/presign',
      expect.objectContaining({ body: { type: 'LICENSE_A1', contentType: 'image/jpeg' } }),
    );
    // 2) Lectura local del archivo elegido.
    expect(fetchImpl).toHaveBeenNthCalledWith(1, FILE.uri);
    // 3) PUT directo al almacén: método PUT + headers EXACTOS del ticket (sin Authorization del BFF).
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      TICKET.uploadUrl,
      expect.objectContaining({ method: 'PUT', headers: TICKET.requiredHeaders }),
    );
    // 4) Devuelve la key del binario subido para que el caso de uso registre el documento.
    expect(result).toEqual({ fileS3Key: TICKET.fileS3Key });
  });

  it('deriva contentType de la extensión cuando el MIME no viene (PDF de galería)', async () => {
    const post = jest.fn(async () => TICKET);
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(localReadOk())
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const pdf: PickedImage = { ...FILE, mimeType: null, fileName: 'tarjeta.PDF', uri: 'file:///x.PDF' };

    await new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch).upload(
      'PROPERTY_CARD',
      pdf,
    );

    expect(post).toHaveBeenCalledWith(
      '/drivers/me/documents/presign',
      expect.objectContaining({
        body: { type: 'PROPERTY_CARD', contentType: 'application/pdf' },
      }),
    );
  });

  it('falla con `unsupported-type` ANTES del presign si el formato no está en la allowlist', async () => {
    const post = jest.fn(async () => TICKET);
    const fetchImpl = jest.fn();
    const gif: PickedImage = { ...FILE, mimeType: 'image/gif', fileName: 'x.gif', uri: 'file:///x.gif' };

    await expect(
      new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch).upload(
        'SOAT',
        gif,
      ),
    ).rejects.toMatchObject({ name: 'DocumentUploadError', reason: 'unsupported-type' });
    expect(post).not.toHaveBeenCalled();
  });

  it('surfacea `presign` cuando el BFF no expide el ticket', async () => {
    const post = jest.fn(async () => {
      throw new Error('HTTP 500');
    });
    const fetchImpl = jest.fn();

    await expect(
      new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch).upload(
        'SOAT',
        FILE,
      ),
    ).rejects.toMatchObject({ name: 'DocumentUploadError', reason: 'presign' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfacea `upload` cuando el almacén rechaza el PUT (status != 2xx)', async () => {
    const post = jest.fn(async () => TICKET);
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(localReadOk())
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response);

    const error = await new HttpDocumentUploader(
      httpStub(post),
      fetchImpl as unknown as typeof fetch,
    )
      .upload('LICENSE_A1', FILE)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DocumentUploadError);
    expect((error as DocumentUploadError).reason).toBe('upload');
  });

  it('surfacea `read` cuando el binario local está vacío (0 bytes)', async () => {
    const post = jest.fn(async () => TICKET);
    const fetchImpl = jest.fn().mockResolvedValueOnce(localReadOk(0));

    await expect(
      new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch).upload(
        'SOAT',
        FILE,
      ),
    ).rejects.toMatchObject({ name: 'DocumentUploadError', reason: 'read' });
  });

  it('surfacea `network` cuando el PUT lanza (fallo de red, no respuesta HTTP)', async () => {
    const post = jest.fn(async () => TICKET);
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(localReadOk())
      .mockRejectedValueOnce(new Error('Network request failed'));

    await expect(
      new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch).upload(
        'SOAT',
        FILE,
      ),
    ).rejects.toMatchObject({ name: 'DocumentUploadError', reason: 'network' });
  });
});
