import type { HttpClient } from '@veo/api-client';
import { DocumentSide } from '@veo/shared-types';
import {
  type DocumentSideFile,
  DocumentUploadError,
} from '../../domain/ports/document-uploader';
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

/** Una sola cara (caso histórico: licencia/SOAT/tarjeta/foto). */
const SINGLE: DocumentSideFile[] = [{ side: DocumentSide.SINGLE, file: FILE }];

/** Ticket de UNA cara (sub-lote 3A): el presign devuelve `tickets[]` aunque sea una sola imagen. */
const SINGLE_TICKET = {
  side: DocumentSide.SINGLE,
  uploadUrl: 'https://storage.veo.local/bucket/drivers/d-1/license.jpg?sig=abc',
  fileS3Key: 'drivers/d-1/license.jpg',
  requiredHeaders: { 'Content-Type': 'image/jpeg' },
};

/** Respuesta del presign para una sola cara (`tickets` con un único SINGLE). */
const SINGLE_RESPONSE = {
  tickets: [SINGLE_TICKET],
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
    const post = jest.fn(async () => SINGLE_RESPONSE);
    // fetchImpl: 1ª llamada = lectura local (uri), 2ª = PUT al uploadUrl.
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(localReadOk())
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const uploader = new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch);
    const result = await uploader.upload('LICENSE_A1', SINGLE);

    // 1) Presign: el body lleva el tipo, el contentType derivado del MIME y las caras pedidas (SINGLE).
    expect(post).toHaveBeenCalledWith(
      '/drivers/me/documents/presign',
      expect.objectContaining({
        body: { type: 'LICENSE_A1', contentType: 'image/jpeg', sides: [DocumentSide.SINGLE] },
      }),
    );
    // 2) Lectura local del archivo elegido.
    expect(fetchImpl).toHaveBeenNthCalledWith(1, FILE.uri);
    // 3) PUT directo al almacén: método PUT + headers EXACTOS del ticket (sin Authorization del BFF).
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      SINGLE_TICKET.uploadUrl,
      expect.objectContaining({ method: 'PUT', headers: SINGLE_TICKET.requiredHeaders }),
    );
    // 4) Devuelve las imágenes subidas (key + cara) para que el caso de uso registre el documento.
    expect(result).toEqual({ images: [{ s3Key: SINGLE_TICKET.fileS3Key, side: DocumentSide.SINGLE }] });
  });

  it('DNI: presign con sides [FRONT, BACK] → sube cada cara emparejando ticket↔archivo por side', async () => {
    const front: PickedImage = { ...FILE, uri: 'data:image/jpeg;base64,FRONT', fileName: 'front.jpg' };
    const back: PickedImage = { ...FILE, uri: 'data:image/jpeg;base64,BACK', fileName: 'back.jpg' };
    const dniSides: DocumentSideFile[] = [
      { side: DocumentSide.FRONT, file: front },
      { side: DocumentSide.BACK, file: back },
    ];
    // El BFF puede devolver los tickets en CUALQUIER orden: el uploader empareja por `side`, no por índice.
    const post = jest.fn(async () => ({
      tickets: [
        {
          side: DocumentSide.BACK,
          uploadUrl: 'https://storage.veo.local/dni-back?sig=b',
          fileS3Key: 'drivers/d-1/dni-back.jpg',
          requiredHeaders: { 'Content-Type': 'image/jpeg' },
        },
        {
          side: DocumentSide.FRONT,
          uploadUrl: 'https://storage.veo.local/dni-front?sig=f',
          fileS3Key: 'drivers/d-1/dni-front.jpg',
          requiredHeaders: { 'Content-Type': 'image/jpeg' },
        },
      ],
      expiresAt: '2026-06-18T12:00:00.000Z',
    }));
    // fetchImpl: read front, PUT front, read back, PUT back (en el orden de `dniSides`).
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(localReadOk())
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockResolvedValueOnce(localReadOk())
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await new HttpDocumentUploader(
      httpStub(post),
      fetchImpl as unknown as typeof fetch,
    ).upload('DNI', dniSides);

    // Presign pide AMBAS caras en orden FRONT, BACK.
    expect(post).toHaveBeenCalledWith(
      '/drivers/me/documents/presign',
      expect.objectContaining({
        body: {
          type: 'DNI',
          contentType: 'image/jpeg',
          sides: [DocumentSide.FRONT, DocumentSide.BACK],
        },
      }),
    );
    // El FRONT se sube a SU uploadUrl (emparejado por side, aunque el ticket vino segundo).
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://storage.veo.local/dni-front?sig=f',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      'https://storage.veo.local/dni-back?sig=b',
      expect.objectContaining({ method: 'PUT' }),
    );
    // Devuelve las dos imágenes con su key y su cara correcta.
    expect(result).toEqual({
      images: [
        { s3Key: 'drivers/d-1/dni-front.jpg', side: DocumentSide.FRONT },
        { s3Key: 'drivers/d-1/dni-back.jpg', side: DocumentSide.BACK },
      ],
    });
  });

  it('deriva contentType de la extensión cuando el MIME no viene (PDF de galería)', async () => {
    const post = jest.fn(async () => ({
      tickets: [{ ...SINGLE_TICKET, requiredHeaders: { 'Content-Type': 'application/pdf' } }],
      expiresAt: '2026-06-18T12:00:00.000Z',
    }));
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(localReadOk())
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const pdf: PickedImage = { ...FILE, mimeType: null, fileName: 'tarjeta.PDF', uri: 'file:///x.PDF' };

    await new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch).upload(
      'PROPERTY_CARD',
      [{ side: DocumentSide.SINGLE, file: pdf }],
    );

    expect(post).toHaveBeenCalledWith(
      '/drivers/me/documents/presign',
      expect.objectContaining({
        body: { type: 'PROPERTY_CARD', contentType: 'application/pdf', sides: [DocumentSide.SINGLE] },
      }),
    );
  });

  it('falla con `unsupported-type` ANTES del presign si el formato no está en la allowlist', async () => {
    const post = jest.fn(async () => SINGLE_RESPONSE);
    const fetchImpl = jest.fn();
    const gif: PickedImage = { ...FILE, mimeType: 'image/gif', fileName: 'x.gif', uri: 'file:///x.gif' };

    await expect(
      new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch).upload(
        'SOAT',
        [{ side: DocumentSide.SINGLE, file: gif }],
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
        SINGLE,
      ),
    ).rejects.toMatchObject({ name: 'DocumentUploadError', reason: 'presign' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfacea `upload` cuando el almacén rechaza el PUT (status != 2xx)', async () => {
    const post = jest.fn(async () => SINGLE_RESPONSE);
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(localReadOk())
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response);

    const error = await new HttpDocumentUploader(
      httpStub(post),
      fetchImpl as unknown as typeof fetch,
    )
      .upload('LICENSE_A1', SINGLE)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DocumentUploadError);
    expect((error as DocumentUploadError).reason).toBe('upload');
  });

  it('surfacea `read` cuando el binario local está vacío (0 bytes)', async () => {
    const post = jest.fn(async () => SINGLE_RESPONSE);
    const fetchImpl = jest.fn().mockResolvedValueOnce(localReadOk(0));

    await expect(
      new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch).upload(
        'SOAT',
        SINGLE,
      ),
    ).rejects.toMatchObject({ name: 'DocumentUploadError', reason: 'read' });
  });

  it('surfacea `network` cuando el PUT lanza (fallo de red, no respuesta HTTP)', async () => {
    const post = jest.fn(async () => SINGLE_RESPONSE);
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(localReadOk())
      .mockRejectedValueOnce(new Error('Network request failed'));

    await expect(
      new HttpDocumentUploader(httpStub(post), fetchImpl as unknown as typeof fetch).upload(
        'SOAT',
        SINGLE,
      ),
    ).rejects.toMatchObject({ name: 'DocumentUploadError', reason: 'network' });
  });
});
